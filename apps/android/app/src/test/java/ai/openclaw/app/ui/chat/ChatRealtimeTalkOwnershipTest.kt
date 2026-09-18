package ai.openclaw.app.ui.chat

import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import ai.openclaw.app.ui.ShellScreen
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.content.Context
import android.provider.Settings
import androidx.activity.compose.LocalActivityResultRegistryOwner
import androidx.activity.result.ActivityResultRegistry
import androidx.activity.result.ActivityResultRegistryOwner
import androidx.activity.result.contract.ActivityResultContract
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.performClick
import androidx.core.app.ActivityOptionsCompat
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.coroutines.CoroutineContext

/** Exercises the shipped launcher -> ViewModel -> runtime -> relay RPC, not a routing replica. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ChatRealtimeTalkOwnershipTest {
  private val composeRule = createComposeRule()

  // Dispose launcher consumers before joining runtime/database cleanup, as in sibling UI fixtures.
  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun after() {
            tearDown()
          }
        },
      ).around(composeRule)

  private lateinit var app: NodeApp
  private lateinit var runtime: NodeRuntime
  private lateinit var model: MainViewModel
  private lateinit var prefs: SecurePrefs
  private lateinit var gateway: ChatRealtimeTalkGatewayFixture
  private var previousRuntime: NodeRuntime? = null
  private var previousAnimatorScale: String? = null
  private val models = ViewModelStore()
  private val gateways = mutableListOf<ChatRealtimeTalkGatewayFixture>()
  private val permissions = DeferredTalkPermissionRegistry()
  private val captureTasks = ConcurrentLinkedQueue<Runnable>()
  private val audioBarriers = mutableListOf<CompletableDeferred<Unit>>()

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    previousAnimatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    gateway = ChatRealtimeTalkGatewayFixture().also(gateways::add)
    prefs = SecurePrefs(app, app.getSharedPreferences("talk-ownership-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-talk-ownership")
    runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    models.put("talk", model)
    model.setForeground(true)

    // Leave the actual routing, lifecycle and GatewaySession intact. Delay only OS audio work;
    // canceled tasks drain during teardown without ever opening a microphone.
    val captureDispatcher =
      object : CoroutineDispatcher() {
        override fun dispatch(
          context: CoroutineContext,
          block: Runnable,
        ) {
          captureTasks.add(block)
        }
      }
    ReflectionHelpers.setField(talkManager(), "realtimeCaptureDispatcher", captureDispatcher)
    val permissionOwner =
      object : ActivityResultRegistryOwner {
        override val activityResultRegistry: ActivityResultRegistry = permissions
      }
    composeRule.setContent {
      CompositionLocalProvider(LocalActivityResultRegistryOwner provides permissionOwner) {
        ShellScreen(model)
      }
    }
    connect(gateway)
    selectChat(FIRST_CHAT)
    composeRule.runOnIdle { model.requestHomeDestination(HomeDestination.Chat) }
  }

  @Test
  fun launchFromNonMainChatSendsItsActualAgentAndConversation() {
    assertFalse(FIRST_CHAT == runtime.mainSessionKey.value)
    startTalk()
    awaitCreate()
    val request = gateway.creates.single().request
    val key =
      request.params
        .getValue("sessionKey")
        .jsonPrimitive.content
    assertEquals(
      ChatComposerOwner(gateway.endpoint.stableId, "scout", FIRST_CHAT),
      ChatComposerOwner(gateway.endpoint.stableId, checkNotNull(resolveAgentIdFromMainSessionKey(key)), key),
    )
    assertEquals(FIRST_CHAT, runtime.chatSessionKey.value)
    assertEquals(
      "realtime",
      request.params
        .getValue("mode")
        .jsonPrimitive.content,
    )
    assertEquals(
      "gateway-relay",
      request.params
        .getValue("transport")
        .jsonPrimitive.content,
    )
    assertEquals(
      "agent-consult",
      request.params
        .getValue("brain")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun permissionGrantForUnchangedChatStillStartsItsCapturedTarget() {
    requestMicrophonePermission()
    grantMicrophonePermission()
    awaitCreate()
    assertEquals(
      FIRST_CHAT,
      gateway.creates
        .single()
        .request.params
        .getValue("sessionKey")
        .jsonPrimitive.content,
    )
  }

  @Test
  fun permissionResultSurvivesLeavingTheChatPageWithoutChangingItsOwner() {
    requestMicrophonePermission()
    composeRule.runOnIdle { model.requestHomeDestination(HomeDestination.Settings) }
    composeRule.waitForIdle()
    grantMicrophonePermission()
    awaitCreate()
    assertEquals(
      FIRST_CHAT,
      gateway.creates
        .single()
        .request.params
        .getValue("sessionKey")
        .jsonPrimitive.content,
    )
    assertEquals(1, gateway.creates.size)
  }

  @Test
  fun permissionGrantAfterChatChangeCannotStartEitherConversation() {
    requestMicrophonePermission()
    selectChat(SECOND_CHAT)
    grantMicrophonePermission()
    assertNoPendingTalkStart()
    assertEquals(SECOND_CHAT, runtime.chatSessionKey.value)
  }

  @Test
  fun permissionGrantAfterAgentChangeCannotStartTheNewAgent() {
    requestMicrophonePermission()
    selectChat(WRITER_CHAT, agentId = "writer")
    grantMicrophonePermission()
    assertNoPendingTalkStart()
    assertEquals("writer", runtime.chatSessionOwnerAgentId.value)
    assertEquals(WRITER_CHAT, runtime.chatSessionKey.value)
  }

  @Test
  fun returningToSameChatDoesNotReviveItsOldPermissionRequest() {
    requestMicrophonePermission()
    selectChat(SECOND_CHAT)
    selectChat(FIRST_CHAT)
    grantMicrophonePermission()
    assertNoPendingTalkStart()
  }

  @Test
  fun permissionGrantAfterGatewayReplacementCannotStartOnTheReplacement() {
    requestMicrophonePermission()
    val replacement = ChatRealtimeTalkGatewayFixture().also(gateways::add)
    prefs.saveGatewayCredentials(replacement.endpoint.stableId, token = "synthetic-talk-replacement")
    connect(replacement)
    selectChat(FIRST_CHAT)
    grantMicrophonePermission()
    assertNoPendingTalkStart()
  }

  @Test
  fun targetChangeWhileAudioRetiresCancelsPendingStartup() {
    val released = CompletableDeferred<Unit>().also(audioBarriers::add)
    talkManager().audioRetirement.retire(cleanup = released)
    startTalk()
    assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
    assertFalse(runtime.talkModeEnabled.value)
    assertTrue(gateway.creates.isEmpty())
    selectChat(SECOND_CHAT)
    // This is a real suspended startup, not a source-text assertion. Selection must retire it.
    composeRule.waitUntil(TIMEOUT_MS) { runtime.voiceCaptureMode.value == VoiceCaptureMode.Off }
    released.complete(Unit)
    composeRule.waitUntil(TIMEOUT_MS) { !talkManager().audioRetirement.pending }
    assertNoPendingTalkStart()
  }

  @Test
  fun targetChangeDuringRelayAdmissionClosesLateResultOnOriginalConnection() {
    startTalk()
    awaitCreate()
    val pending = gateway.creates.single()
    selectChat(SECOND_CHAT)
    pending.complete()
    // Either outcome proves admission finished: baseline wrongly installs capture; repair closes it.
    composeRule.waitUntil(TIMEOUT_MS) { closeRequests().isNotEmpty() || runtime.talkModeListening.value }
    val closed = closeRequests()
    assertEquals(1, closed.size)
    assertEquals(pending.request.connection, closed.single().connection)
    assertEquals(
      "ownership-relay",
      closed
        .single()
        .params
        .getValue("sessionId")
        .jsonPrimitive.content,
    )
    assertNoPendingTalkStart(expectedCreates = 1)
    assertEquals(SECOND_CHAT, runtime.chatSessionKey.value)
  }

  @Test
  fun intentionalEndStillClosesALateAdmissionWithoutAReplacementCall() {
    startTalk()
    awaitCreate()
    val pending = gateway.creates.single()
    composeRule.runOnIdle { model.setTalkModeEnabled(false) }
    pending.complete()
    composeRule.waitUntil(TIMEOUT_MS) { closeRequests().isNotEmpty() }
    assertEquals(pending.request.connection, closeRequests().single().connection)
    assertEquals(
      "ownership-relay",
      closeRequests()
        .single()
        .params
        .getValue("sessionId")
        .jsonPrimitive.content,
    )
    assertNoPendingTalkStart(expectedCreates = 1)
  }

  private fun connect(target: ChatRealtimeTalkGatewayFixture) {
    composeRule.runOnIdle { runtime.connect(target.endpoint) }
    composeRule.waitUntil(TIMEOUT_MS) {
      runtime.gatewayConnectionDisplay.value.isConnected &&
        model.activeGatewayStableId.value == target.endpoint.stableId &&
        !runtime.gatewayConnectionHandoff.value.pending
    }
  }

  private fun selectChat(
    key: String,
    agentId: String = "scout",
  ) {
    composeRule.runOnIdle { model.switchChatSession(key, ownerAgentId = agentId) }
    composeRule.waitUntil(TIMEOUT_MS) {
      runtime.chatSessionKey.value == key && model.chatSessionKey.value == key &&
        runtime.chatSessionId.value == "transcript-$key" && !runtime.chatHistoryLoading.value
    }
  }

  private fun startTalk() {
    composeRule.onNodeWithContentDescription("Start Talk").performClick()
  }

  private fun awaitCreate() {
    composeRule.waitUntil(TIMEOUT_MS) { gateway.creates.isNotEmpty() }
  }

  private fun requestMicrophonePermission() {
    shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
    startTalk()
    composeRule.runOnIdle { assertTrue(permissions.hasPendingRequest) }
    assertNoPendingTalkStart()
  }

  private fun grantMicrophonePermission() {
    composeRule.runOnIdle {
      shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
      permissions.grant()
    }
  }

  private fun assertNoPendingTalkStart(expectedCreates: Int = 0) {
    composeRule.runOnIdle {
      assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
      assertFalse(runtime.talkModeEnabled.value)
      assertFalse(runtime.talkModeListening.value)
    }
    assertEquals(expectedCreates, gateways.sumOf { it.creates.size })
    assertFalse(gateways.any { target -> target.requests.any { it.method == "talk.session.appendAudio" } })
  }

  private fun closeRequests() = gateway.requests.filter { it.method == "talk.session.close" }

  private fun talkManager(): TalkModeManager = ReflectionHelpers.getField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value

  private fun tearDown() {
    try {
      if (::runtime.isInitialized) runtime.setTalkModeEnabled(false)
      audioBarriers.forEach { it.complete(Unit) }
      gateways.forEach { it.releaseCreates() }
      while (true) (captureTasks.poll() ?: break).run()
      models.clear()
      if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
    } finally {
      if (::app.isInitialized) {
        bindNodeRuntimeTestFixture(app, previousRuntime)
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousAnimatorScale)
      }
      gateways.forEach { it.close() }
    }
  }

  private companion object {
    const val FIRST_CHAT = "agent:scout:project-review"
    const val SECOND_CHAT = "agent:scout:other-review"
    const val WRITER_CHAT = "agent:writer:document-review"
    const val TIMEOUT_MS = 5_000L
  }
}

private class DeferredTalkPermissionRegistry : ActivityResultRegistry() {
  private var requestCode: Int? = null
  val hasPendingRequest: Boolean get() = requestCode != null

  override fun <I, O> onLaunch(
    requestCode: Int,
    contract: ActivityResultContract<I, O>,
    input: I,
    options: ActivityOptionsCompat?,
  ) {
    check(this.requestCode == null) { "Duplicate permission launch" }
    assertEquals(Manifest.permission.RECORD_AUDIO, input)
    this.requestCode = requestCode
  }

  fun grant() {
    val pending = checkNotNull(requestCode)
    requestCode = null
    check(dispatchResult(pending, true)) { "Permission result has no registered launcher" }
  }
}

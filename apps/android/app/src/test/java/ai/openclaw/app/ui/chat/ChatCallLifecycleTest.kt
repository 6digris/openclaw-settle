package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.PermissionRequester
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.ui.UnifiedChatShellScreen
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.lifecycle.SavedStateHandle
import androidx.lifecycle.ViewModelStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.annotation.Config
import org.robolectric.util.ReflectionHelpers
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.coroutines.CoroutineContext

/** Actual Chat -> launcher -> runtime -> socket admission. No device/provider work is required. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
class ChatCallLifecycleTest {
  private val composeRule = createComposeRule()

  @get:Rule
  val fixtureRules: RuleChain =
    RuleChain.outerRule(
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
  private val captureTasks = ConcurrentLinkedQueue<Pair<Job, Runnable>>()
  private val retirements = mutableListOf<CompletableDeferred<Unit>>()
  private val photoScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
  private lateinit var photoPermissions: PermissionRequester
  private var permissionActivity: ActivityController<ComponentActivity>? = null
  private val cameraPermissionRequests = mutableListOf<Pair<Array<String>, Int>>()

  @Before
  fun setUp() {
    app = RuntimeEnvironment.getApplication() as NodeApp
    previousRuntime = app.peekRuntime()
    shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO)
    // As in ChatComposerLayoutTest, remove ambient motion for owner/layout assertions.
    // This fixture does not claim animation or physical microphone proof.
    previousAnimatorScale = Settings.Global.getString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
    Settings.Global.putFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 0f)
    gateway = ChatRealtimeTalkGatewayFixture()
    prefs = SecurePrefs(app, app.getSharedPreferences("chat-call-${UUID.randomUUID()}", Context.MODE_PRIVATE))
    prefs.setManualTls(false)
    prefs.saveGatewayCredentials(gateway.endpoint.stableId, token = "synthetic-chat-call")
    runtime = NodeRuntime(app, prefs)
    bindNodeRuntimeTestFixture(app, runtime)
    model = MainViewModel(app, prefs, SavedStateHandle())
    photoPermissions = PermissionRequester(app)
    ReflectionHelpers.setField(model, "permissionRequester", photoPermissions)
    prefs.setCameraEnabled(true)
    models.put("chat-call", model)
    model.setForeground(true)
    ReflectionHelpers.setField(
      talkManager(),
      "realtimeCaptureDispatcher",
      object : CoroutineDispatcher() {
        override fun dispatch(context: CoroutineContext, block: Runnable) {
          captureTasks.add(checkNotNull(context[Job]) to block)
        }
      },
    )
    composeRule.setContent {
      ClawDesignTheme {
        UnifiedChatShellScreen(
          viewModel = model,
          showSidebarButton = true,
          onOpenSidebar = {},
          onOpenDashboard = {},
          onOpenGatewaySettings = {},
          onOpenProvidersModels = {},
        )
      }
    }
    composeRule.runOnIdle { runtime.connect(gateway.endpoint) }
    awaitUiState {
      runtime.gatewayConnectionDisplay.value.isConnected &&
        model.activeGatewayStableId.value == gateway.endpoint.stableId &&
        !runtime.gatewayConnectionHandoff.value.pending
    }
    selectChat(FIRST_CHAT)
  }

  @Test
  fun callCardKeepsTheCapturedOwnerAndDraftAcrossNavigation() {
    val owner = ChatComposerOwner(gateway.endpoint.stableId, "scout", FIRST_CHAT)
    composeRule.runOnIdle { model.chatComposerState.textDrafts[owner] = "Keep this unsent draft" }
    // A nonempty draft owns Send, so start through the same ViewModel admission used by the launcher.
    composeRule.runOnIdle { model.startChatTalk(checkNotNull(model.captureChatTalkStart())) }
    awaitCreate().complete()
    awaitListening(expectChatCall = true)
    selectChat(SECOND_CHAT)
    composeRule.onNodeWithTag("chat-call-card").assertIsDisplayed()
    composeRule.onNodeWithText(FIRST_CHAT).assertIsDisplayed()
    composeRule.onNodeWithText("Call · scout").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("End Talk").assertIsDisplayed()
    composeRule.onNodeWithText("Photo").assertIsNotEnabled()
    composeRule.onNodeWithText("Return to the call's chat before taking a photo.").assertIsDisplayed()
    composeRule.onNode(hasSetTextAction()).assertIsDisplayed()
    assertEquals(SECOND_CHAT, runtime.chatSessionKey.value)
    assertEquals(1, gateway.creates.size)
    val audioBefore = prefs.speakerEnabled.value
    composeRule.onNodeWithContentDescription("Speaker audio").performClick()
    assertEquals(!audioBefore, prefs.speakerEnabled.value)
    composeRule.onNodeWithText("End").performClick()
    awaitStopped()
    awaitUiState { closes().size == 1 }
    assertEquals(gateway.creates.single().request.connection, closes().single().connection)
    assertEquals("ownership-relay", closes().single().params.getValue("sessionId").jsonPrimitive.content)
    assertEquals("Keep this unsent draft", model.chatComposerState.textDrafts[owner])
    composeRule.onNodeWithTag("chat-call-card").assertDoesNotExist()
  }

  @Test
  fun backgroundRetainsAnAdmittedChatCallWithoutRestartOrDuplicateClose() {
    startCall()
    composeRule.runOnIdle { model.setForeground(false) }
    composeRule.runOnIdle {
      assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
      assertTrue(runtime.talkModeEnabled.value)
      assertTrue(runtime.talkModeListening.value)
      assertNull(model.captureChatTalkStart())
    }
    composeRule.runOnIdle { model.setForeground(true) }
    composeRule.onNodeWithTag("chat-call-card").assertIsDisplayed()
    assertEquals(1, gateway.creates.size)
    assertTrue(closes().isEmpty())
    composeRule.onNodeWithText("End").performClick()
    awaitStopped()
  }

  @Test
  fun backgroundBeforeAdmissionClosesTheLateResultOnItsOriginalSocket() {
    composeRule.onNodeWithContentDescription("Start Talk").performClick()
    val pending = awaitCreate()
    composeRule.runOnIdle { model.setForeground(false) }
    awaitStopped()
    pending.complete()
    awaitUiState { closes().isNotEmpty() }
    assertEquals(pending.request.connection, closes().single().connection)
    composeRule.runOnIdle { model.setForeground(true) }
    composeRule.onNodeWithTag("chat-call-card").assertDoesNotExist()
    assertEquals(1, gateway.creates.size)
    assertFalse(runtime.talkModeListening.value)
  }

  @Test
  fun backgroundWhileOldAudioRetiresCannotStartANewCall() {
    val retirement = CompletableDeferred<Unit>().also(retirements::add)
    talkManager().audioRetirement.retire(cleanup = retirement)
    val tap = checkNotNull(model.captureChatTalkStart())
    composeRule.runOnIdle { model.startChatTalk(tap) }
    assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
    composeRule.runOnIdle { model.setForeground(false) }
    awaitStopped()
    retirement.complete(Unit)
    awaitUiState { !talkManager().audioRetirement.pending }
    composeRule.runOnIdle {
      model.setForeground(true)
      model.startChatTalk(tap)
    }
    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertTrue(gateway.creates.isEmpty())
  }

  @Test
  fun genericTalkDoesNotAcquireTheChatBackgroundException() {
    composeRule.runOnIdle { model.setTalkModeEnabled(true) }
    awaitCreate().complete()
    awaitListening()
    composeRule.onNodeWithTag("chat-call-card").assertDoesNotExist()
    composeRule.runOnIdle { model.setForeground(false) }
    awaitStopped()
    awaitUiState { closes().isNotEmpty() }
  }

  @Test
  fun staleCardControlsCannotStopOrMuteAReplacementWithTheSameRelayId() {
    startCall()
    val oldEndNode = composeRule.onNodeWithText("End").fetchSemanticsNode()
    val oldComposerEndNode = composeRule.onNodeWithContentDescription("End Talk").fetchSemanticsNode()
    val oldAudioNode = composeRule.onNodeWithContentDescription("Speaker audio").fetchSemanticsNode()
    val oldEnd = checkNotNull(oldEndNode.config[SemanticsActions.OnClick].action)
    val oldComposerEnd = checkNotNull(oldComposerEndNode.config[SemanticsActions.OnClick].action)
    val oldAudio = checkNotNull(oldAudioNode.config[SemanticsActions.OnClick].action)
    withFrozenCallFrame {
      composeRule.runOnUiThread { oldEnd() }
      awaitStopped()
      awaitUiState { closes().size == 1 }
      startReplacementCallBeforeFrame()
      val audioBefore = prefs.speakerEnabled.value
      composeRule.runOnUiThread {
        // Saved semantics belong to attached A, while the real runtime already owns call B.
        assertTrue(oldEndNode.boundsInRoot.height > 0f)
        assertTrue(oldComposerEndNode.boundsInRoot.height > 0f)
        assertTrue(oldAudioNode.boundsInRoot.height > 0f)
        oldEnd()
        oldComposerEnd()
        oldAudio()
      }
      assertTrue(runtime.talkModeEnabled.value)
      assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
      assertEquals(audioBefore, prefs.speakerEnabled.value)
      assertEquals(1, closes().size)
    }
    composeRule.onNodeWithText("End").performClick()
    awaitStopped()
  }

  @Test
  fun anEndedCallCannotBeRestartedByItsOldTap() {
    val tap = checkNotNull(model.captureChatTalkStart())
    composeRule.runOnIdle { model.startChatTalk(tap) }
    awaitCreate().complete()
    awaitListening(expectChatCall = true)
    composeRule.onNodeWithText("End").performClick()
    awaitStopped()
    awaitUiState { closes().size == 1 }
    composeRule.runOnIdle { model.startChatTalk(tap) }
    assertEquals(VoiceCaptureMode.Off, runtime.voiceCaptureMode.value)
    assertFalse(tap.canStart())
    assertEquals(1, gateway.creates.size)
  }

  @Test
  fun backgroundAudioNeverEnablesNodeCameraCapture() {
    startCall()
    val dispatcher = ReflectionHelpers.getField<InvokeDispatcher>(runtime, "invokeDispatcher")
    composeRule.runOnIdle { prefs.setCameraEnabled(false) }
    val disabled = runBlocking { dispatcher.handleInvoke("camera.snap", null) }
    assertEquals("CAMERA_DISABLED", disabled.error?.code)
    composeRule.runOnIdle {
      prefs.setCameraEnabled(true)
      model.setForeground(false)
    }
    val background = runBlocking { dispatcher.handleInvoke("camera.snap", null) }
    assertEquals("NODE_BACKGROUND_UNAVAILABLE", background.error?.code)
    assertTrue(runtime.talkModeEnabled.value)
    assertFalse(gateway.requests.any { it.method == "chat.send" || it.method == "talk.client.toolCall" })
  }

  @Test
  fun revokedMicrophonePermissionPreventsBackgroundContinuation() {
    startCall()
    composeRule.runOnIdle {
      shadowOf(app).denyPermissions(Manifest.permission.RECORD_AUDIO)
      model.setForeground(false)
    }
    awaitStopped()
  }

  @Test
  fun relayPhotoStagesInTheOwnerPreviewUntilExplicitNormalSend() {
    startCall()
    assertTrue(checkNotNull(model.chatTalkCall.value).realtime)
    composeRule.onNodeWithText("Photo").assertIsEnabled()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val photo = takePhoto()
    assertEquals("Photo ready to send.", awaitPhoto(photo))
    assertFalse(model.chatComposerState.hasPendingGatewaySwitchWork(owner))
    assertEquals(PHOTO_BASE64, model.chatComposerState.attachments.value.getValue(owner).single().base64)
    composeRule.onNodeWithTag("chat-call-card").assertIsDisplayed()
    composeRule.onNodeWithText("camera.jpg").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Remove attachment").assertIsDisplayed()
    composeRule.onNode(hasSetTextAction()).performTextInput("Describe this photo")
    assertEquals("Describe this photo", model.chatComposerState.textDrafts[owner])
    assertNoPhotoSend()
    composeRule.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
    awaitUiState { gateway.requests.any { it.method == "chat.send" } }
    val sent = gateway.requests.single { it.method == "chat.send" }
    assertEquals(FIRST_CHAT, sent.params.getValue("sessionKey").jsonPrimitive.content)
    assertTrue(sent.params.toString().contains(PHOTO_BASE64))
    assertFalse(gateway.requests.any { it.method == "talk.client.toolCall" })
    // The fixture intentionally refuses chat.send; this proves submission, not provider analysis/TTS.
  }

  @Test
  @Config(qualifiers = "w360dp-h320dp-420dpi")
  fun compactCallKeepsItsComposerAndScrollablePhotoControls() {
    startCall()
    composeRule.onNode(hasSetTextAction()).assertIsDisplayed()
    composeRule.onNodeWithText("Photo").performScrollTo().assertIsDisplayed().assertIsEnabled()
    composeRule.onNodeWithContentDescription("End Talk").assertIsDisplayed()
    val input = composeRule.onNodeWithTag("chat-composer-surface").fetchSemanticsNode().boundsInRoot
    val end = composeRule.onNodeWithContentDescription("End Talk").fetchSemanticsNode().boundsInRoot
    assertTrue(end.top >= input.top && end.bottom <= input.bottom)
  }

  @Test
  fun oldGenericEndCannotStopANewChatCall() {
    composeRule.runOnIdle { model.setTalkModeEnabled(true) }
    awaitCreate().complete()
    awaitListening()
    val oldEndNode = composeRule.onNodeWithContentDescription("End Talk").fetchSemanticsNode()
    val oldEnd = checkNotNull(oldEndNode.config[SemanticsActions.OnClick].action)
    withFrozenCallFrame {
      composeRule.runOnUiThread { oldEnd() }
      awaitStopped()
      startReplacementCallBeforeFrame()
      composeRule.runOnUiThread {
        assertTrue(oldEndNode.boundsInRoot.height > 0f)
        oldEnd()
      }
      assertTrue(runtime.talkModeEnabled.value)
      assertEquals(VoiceCaptureMode.TalkMode, runtime.voiceCaptureMode.value)
    }
  }

  @Test
  fun photoPermissionReturningAfterNavigationCannotCaptureOrRetarget() {
    startCall()
    prepareCameraPermissionPrompt()
    var captures = 0
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val photo = takePhoto { _, _ -> captures++; photoPayload() }
    awaitUiState { cameraPermissionRequests.size == 1 }
    assertTrue(model.chatComposerState.hasPendingGatewaySwitchWork(owner))
    selectChat(SECOND_CHAT)
    selectChat(FIRST_CHAT)
    grantCameraPermission()
    assertEquals("Photo cancelled because the call or camera access changed.", awaitPhoto(photo))
    assertEquals(0, captures)
    assertPhotoRetired(owner)
  }

  @Test
  fun photoResultReturningAfterBackgroundRoundTripCannotStage() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val image = CompletableDeferred<CameraCaptureManager.Payload>()
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val entered = CompletableDeferred<Unit>()
    val photo = takePhoto { _, isCurrent ->
      assertTrue(isCurrent())
      entered.complete(Unit)
      image.await()
    }
    awaitUiState { entered.isCompleted }
    composeRule.runOnIdle {
      model.setForeground(false)
      model.setForeground(true)
    }
    image.complete(photoPayload())
    assertEquals("Photo cancelled because the call or camera access changed.", awaitPhoto(photo))
    assertTrue(runtime.talkModeEnabled.value)
    assertPhotoRetired(owner)
  }

  @Test
  fun latePhotoCannotStageIntoReplacementCallWithTheSameRelayId() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val image = CompletableDeferred<CameraCaptureManager.Payload>()
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val photo = takePhoto { _, _ -> image.await() }
    awaitUiState { model.chatComposerState.hasPendingGatewaySwitchWork(owner) }
    composeRule.onNodeWithText("End").performClick()
    awaitStopped()
    startCall(createCount = 2)
    image.complete(photoPayload())
    assertEquals("Photo cancelled because the call or camera access changed.", awaitPhoto(photo))
    assertTrue(runtime.talkModeEnabled.value)
    assertPhotoRetired(owner)
  }

  @Test
  fun photoResultCannotSurviveLossOfItsOriginalSocket() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val image = CompletableDeferred<CameraCaptureManager.Payload>()
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val photo = takePhoto { _, _ -> image.await() }
    awaitUiState { model.chatComposerState.hasPendingGatewaySwitchWork(owner) }
    composeRule.runOnIdle { runtime.disconnect() }
    awaitUiState { !runtime.gatewayConnectionDisplay.value.isConnected }
    image.complete(photoPayload())
    assertEquals("Photo cancelled because the call or camera access changed.", awaitPhoto(photo))
    assertPhotoRetired(owner)
  }

  @Test
  fun cameraRevocationRetiresTheCapturedResult() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val image = CompletableDeferred<CameraCaptureManager.Payload>()
    val photo = takePhoto { _, _ -> image.await() }
    awaitUiState { model.chatComposerState.hasPendingGatewaySwitchWork(owner) }
    composeRule.runOnIdle { shadowOf(app).denyPermissions(Manifest.permission.CAMERA) }
    image.complete(photoPayload())
    assertEquals("Photo cancelled because the call or camera access changed.", awaitPhoto(photo))
    assertPhotoRetired(owner)
  }

  @Test
  fun cancellationAndCameraFailureReleaseMediaAcquisition() {
    startCall()
    prepareCameraPermissionPrompt()
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val photo = takePhoto()
    awaitUiState { cameraPermissionRequests.size == 1 }
    composeRule.runOnIdle { photo.cancel() }
    awaitUiState { photo.isCompleted }
    val (permissions, code) = cameraPermissionRequests.single()
    assertFalse(photoPermissions.onRequestPermissionsResult(code, permissions, intArrayOf(PackageManager.PERMISSION_GRANTED)))
    assertPhotoRetired(owner)
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val failed = takePhoto { _, _ -> error("CAMERA_BUSY: another camera capture is active") }
    awaitUiState { failed.isCompleted }
    assertThrows(IllegalStateException::class.java) { runBlocking { failed.await() } }
    assertPhotoRetired(owner)
  }

  @Test
  fun stagedPhotosKeepTheExistingAttachmentLimitAndNotice() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val existing = List(CHAT_COMPOSER_MAX_ATTACHMENTS) { index ->
      PendingAttachment("existing-$index", "image-$index.jpg", "image/jpeg", PHOTO_BASE64)
    }
    composeRule.runOnIdle { model.chatComposerState.addAttachments(owner, existing) }
    assertEquals("Photo not added. Remove an attachment and try again.", awaitPhoto(takePhoto()))
    assertEquals(existing, model.chatComposerState.attachments.value[owner])
    assertEquals(ChatComposerAttachmentNotice.Attachment, model.chatComposerState.attachmentNotices.value[owner])
    assertFalse(model.chatComposerState.hasPendingGatewaySwitchWork(owner))
    assertNoPhotoSend()
  }

  /** Replace only physical capture; permission, call/route fences, staging and Send remain real. */
  private fun takePhoto(
    capture: suspend (NodeRuntime, () -> Boolean) -> CameraCaptureManager.Payload = { capturedRuntime, isCurrent ->
      assertSame(runtime, capturedRuntime)
      assertTrue(isCurrent())
      photoPayload()
    },
  ): Deferred<NativeText> {
    val start = checkNotNull(model.chatTalkCall.value).start
    lateinit var result: Deferred<NativeText>
    composeRule.runOnIdle { result = photoScope.async { model.stageChatTalkPhoto(start, capture) } }
    return result
  }

  private fun awaitPhoto(photo: Deferred<NativeText>): String {
    awaitUiState { photo.isCompleted }
    return runBlocking { photo.await() }.resolveNativeText()
  }

  private fun assertPhotoRetired(owner: ChatComposerOwner) {
    assertTrue(model.chatComposerState.attachments.value.isEmpty())
    assertFalse(model.chatComposerState.hasPendingGatewaySwitchWork(owner))
    assertNoPhotoSend()
  }

  private fun assertNoPhotoSend() {
    assertFalse(gateway.requests.any { it.method == "chat.send" || it.method == "talk.client.toolCall" })
  }

  private fun photoPayload() = CameraCaptureManager.Payload("""{"format":"jpg","base64":"$PHOTO_BASE64"}""")

  private fun prepareCameraPermissionPrompt() {
    shadowOf(app).denyPermissions(Manifest.permission.CAMERA)
    composeRule.runOnIdle {
      val controller = Robolectric.buildActivity(ComponentActivity::class.java).setup()
      permissionActivity = controller
      photoPermissions.attach(controller.get()) { permissions, code -> cameraPermissionRequests += permissions to code }
      photoPermissions.activate(controller.get())
    }
  }

  private fun grantCameraPermission() {
    composeRule.runOnIdle {
      shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
      val (permissions, code) = cameraPermissionRequests.single()
      assertTrue(photoPermissions.onRequestPermissionsResult(code, permissions, intArrayOf(PackageManager.PERMISSION_GRANTED)))
    }
  }

  private fun startCall(createCount: Int = 1) {
    composeRule.onNodeWithContentDescription("Start Talk").performClick()
    awaitCreate(createCount).complete()
    awaitListening(expectChatCall = true)
  }

  private fun withFrozenCallFrame(block: () -> Unit) {
    val autoAdvance = composeRule.mainClock.autoAdvance
    val beforeFrame = composeRule.mainClock.currentTime
    composeRule.mainClock.autoAdvance = false
    try {
      block()
      assertEquals("Retired actions must run before the replacement frame", beforeFrame, composeRule.mainClock.currentTime)
    } finally {
      composeRule.mainClock.autoAdvance = autoAdvance
    }
    composeRule.waitForIdle()
  }

  private fun startReplacementCallBeforeFrame() {
    check(!composeRule.mainClock.autoAdvance)
    // Keep A rendered; use the same production admission boundary to establish B before redraw.
    composeRule.runOnUiThread { model.startChatTalk(checkNotNull(model.captureChatTalkStart())) }
    awaitCreate(2).complete()
    awaitListening(expectChatCall = true)
  }

  private fun awaitUiState(condition: () -> Boolean) {
    // Android Main backs ViewModel/permission work; Compose clock advancement alone does not drain it.
    composeRule.waitUntil(TIMEOUT_MS) { composeRule.runOnIdle(condition) }
  }

  private fun awaitCreate(count: Int = 1): PendingTalkOwnershipCreate {
    awaitUiState { gateway.creates.size == count }
    return gateway.creates.last()
  }

  private fun awaitListening(expectChatCall: Boolean = false) {
    // ChatScreen consumes the asynchronous ViewModel projection, not the earlier runtime emission.
    awaitUiState {
      val call = model.chatTalkCall.value
      runtime.talkModeListening.value && model.talkModeEnabled.value && model.talkModeListening.value &&
        (!expectChatCall || (call != null && call.start === runtime.chatTalkCall.value?.start))
    }
  }

  private fun awaitStopped() {
    awaitUiState {
      runtime.voiceCaptureMode.value == VoiceCaptureMode.Off && model.voiceCaptureMode.value == VoiceCaptureMode.Off &&
        !model.talkModeEnabled.value && !model.talkModeListening.value && model.chatTalkCall.value == null
    }
    assertFalse(runtime.talkModeEnabled.value)
    assertFalse(runtime.talkModeListening.value)
    composeRule.runOnIdle { drainRetiredCaptureTasks() }
  }

  private fun drainRetiredCaptureTasks() {
    while (true) {
      val (job, task) = captureTasks.poll() ?: break
      // DEFAULT-start capture jobs must be cancelled before dispatch; never open a fixture microphone.
      check(job.isCancelled) { "Fixture may dispatch only cancelled capture work" }
      task.run()
    }
  }

  private fun selectChat(key: String) {
    composeRule.runOnIdle { model.switchChatSession(key, ownerAgentId = "scout") }
    awaitUiState {
      runtime.chatSessionKey.value == key && model.chatSessionKey.value == key &&
        runtime.chatSessionId.value == "transcript-$key" && !runtime.chatHistoryLoading.value
    }
  }

  private fun closes() = gateway.requests.filter { it.method == "talk.session.close" }

  private fun talkManager(): TalkModeManager = ReflectionHelpers.getField<Lazy<TalkModeManager>>(runtime, "talkMode\$delegate").value

  private fun tearDown() {
    try {
      photoScope.cancel()
      if (::runtime.isInitialized) runtime.setTalkModeEnabled(false)
      retirements.forEach { it.complete(Unit) }
      if (::gateway.isInitialized) gateway.releaseCreates()
      drainRetiredCaptureTasks()
      models.clear()
      if (::runtime.isInitialized) closeNodeRuntimeTestFixture(runtime)
    } finally {
      permissionActivity?.pause()?.stop()?.destroy()
      if (::app.isInitialized) {
        bindNodeRuntimeTestFixture(app, previousRuntime)
        Settings.Global.putString(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousAnimatorScale)
      }
      if (::gateway.isInitialized) gateway.close()
    }
  }

  private companion object {
    const val FIRST_CHAT = "agent:scout:call-owner"
    const val SECOND_CHAT = "agent:scout:other-chat"
    const val TIMEOUT_MS = 5_000L
    const val PHOTO_BASE64 = "c3ludGhldGljLWNhbWVyYS1wYXlsb2Fk"
  }
}

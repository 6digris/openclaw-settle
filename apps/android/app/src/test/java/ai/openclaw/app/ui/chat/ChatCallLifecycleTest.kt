package ai.openclaw.app.ui.chat

import ai.openclaw.app.AppearanceThemeMode
import ai.openclaw.app.HomeDestination
import ai.openclaw.app.MainViewModel
import ai.openclaw.app.NodeApp
import ai.openclaw.app.NodeRuntime
import ai.openclaw.app.PermissionRequester
import ai.openclaw.app.SecurePrefs
import ai.openclaw.app.VoiceCaptureMode
import ai.openclaw.app.bindNodeRuntimeTestFixture
import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.chat.ChatController
import ai.openclaw.app.closeNodeRuntimeTestFixture
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.node.CameraCaptureManager
import ai.openclaw.app.node.InvokeDispatcher
import ai.openclaw.app.ui.ShellScreen
import ai.openclaw.app.ui.design.ClawDesignTheme
import ai.openclaw.app.voice.TalkAgentActivity
import ai.openclaw.app.voice.TalkAudioPlaying
import ai.openclaw.app.voice.TalkModeManager
import ai.openclaw.app.voice.TalkSpeakAudio
import android.Manifest
import android.content.ComponentName
import android.content.Context
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import android.provider.Settings
import android.speech.RecognitionService
import android.speech.SpeechRecognizer
import android.view.KeyEvent
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedDispatcher
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.DeviceConfigurationOverride
import androidx.compose.ui.test.FontScale
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.isDialog
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.TextLayoutResult
import androidx.compose.ui.unit.dp
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
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
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog
import org.robolectric.shadows.ShadowSpeechRecognizer
import org.robolectric.shadows.ShadowSystemClock
import org.robolectric.util.ReflectionHelpers
import java.io.File
import java.time.Duration
import java.util.UUID
import java.util.concurrent.ConcurrentLinkedQueue
import kotlin.coroutines.CoroutineContext

/** Actual Chat -> launcher -> runtime -> socket admission. No device/provider work is required. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class ChatCallLifecycleTest {
  private val composeRule = createComposeRule()
  private var viewportHeight by mutableStateOf(800.dp)
  private var fixtureFontScale by mutableStateOf(1f)

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

  private lateinit var backDispatcher: OnBackPressedDispatcher
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
        override fun dispatch(
          context: CoroutineContext,
          block: Runnable,
        ) {
          captureTasks.add(checkNotNull(context[Job]) to block)
        }
      },
    )
    composeRule.setContent {
      backDispatcher = checkNotNull(LocalOnBackPressedDispatcherOwner.current).onBackPressedDispatcher
      DeviceConfigurationOverride(DeviceConfigurationOverride.FontScale(fixtureFontScale)) {
        ClawDesignTheme {
          Box(Modifier.size(360.dp, viewportHeight).clipToBounds()) {
            ShellScreen(viewModel = model, modifier = Modifier.testTag("chat-avatar-proof"))
          }
        }
      }
    }
    composeRule.runOnIdle { runtime.connect(gateway.endpoint) }
    awaitUiState {
      runtime.gatewayConnectionDisplay.value.isConnected &&
        model.activeGatewayStableId.value == gateway.endpoint.stableId &&
        !runtime.gatewayConnectionHandoff.value.pending
    }
    selectChat(FIRST_CHAT)
    composeRule.runOnIdle { model.requestHomeDestination(HomeDestination.Chat) }
  }

  @Test
  fun layoutFollowupEmptyCallCentersAvatarAndAnchorsEnd() {
    startCall()
    for (dark in listOf(true, false)) {
      composeRule.runOnIdle { prefs.setAppearanceThemeMode(if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light) }
      composeRule.waitForIdle()
      captureTalkProof(if (dark) "layout-empty-dark" else "layout-empty-light")
    }
    val page = composeRule.onNodeWithTag("chat-conversation-page").fetchSemanticsNode().boundsInRoot
    val end =
      composeRule
        .onNodeWithText("End")
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .boundsInRoot
    val avatar =
      composeRule
        .onNodeWithTag("conversation-mascot")
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .boundsInRoot
    val density = app.resources.displayMetrics.density
    assertTrue("End must remain at the bottom safe-area edge, not halfway up the page", page.bottom - end.bottom <= 12f * density)
    assertTrue("The centered avatar should be modestly larger than 240dp", avatar.width / density in 250f..272f)
    assertTrue("The avatar must use the available middle area", avatar.center.y > page.top + page.height * 0.32f)
    composeRule.onNodeWithTag("conversation-transcript").assertDoesNotExist()
  }

  @Test
  fun layoutFollowupShowsFourLinesOfActualSpeech() {
    startCall()
    val spoken = "First spoken line.\nSecond spoken line.\nThird spoken line.\nFourth spoken line.\nThis fifth line must be ellipsized."
    sendCaption("assistant", spoken)
    awaitUiState {
      talkManager()
        .conversation.value
        .lastOrNull()
        ?.text == spoken
    }
    for (dark in listOf(true, false)) {
      composeRule.runOnIdle { prefs.setAppearanceThemeMode(if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light) }
      composeRule.waitForIdle()
      captureTalkProof(if (dark) "layout-transcript-dark" else "layout-transcript-light")
    }
    val text = composeRule.onNodeWithText(spoken).assertIsDisplayed().fetchSemanticsNode()
    val layouts = mutableListOf<TextLayoutResult>()
    checkNotNull(text.config[SemanticsActions.GetTextLayoutResult].action).invoke(layouts)
    assertEquals("Exactly four displayed lines for a longer spoken utterance", 4, layouts.single().lineCount)
    assertTrue(layouts.single().isLineEllipsized(3))
    composeRule.onNodeWithText("scout").assertIsDisplayed()
    composeRule.onNodeWithText("End").assertIsDisplayed()
  }

  @Test
  fun layoutFollowupControlsStayFixedWithSpeechPhotosAndNotices() {
    startCall()
    val initial =
      composeRule
        .onNodeWithText("End")
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .boundsInRoot
    sendCaption("user", "A real spoken question for this call.")
    awaitCaption("A real spoken question for this call.")
    composeRule.onNodeWithText("You").assertIsDisplayed()
    assertEquals(initial, composeRule.onNodeWithText("End").fetchSemanticsNode().boundsInRoot)
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    assertEquals("Photo ready to send.", awaitPhoto(takePhoto()))
    assertEquals(
      initial,
      composeRule
        .onNodeWithText("End")
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .boundsInRoot,
    )
    composeRule.onNodeWithText("Send photos").performScrollTo().assertIsDisplayed()
    composeRule.runOnIdle { prefs.setCameraEnabled(false) }
    composeRule.waitForIdle()
    assertEquals(
      initial,
      composeRule
        .onNodeWithText("End")
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .boundsInRoot,
    )
    captureTalkProof("layout-photos-controls")
    assertNoPhotoSend()
  }

  @Test
  fun layoutFollowupOriginalCallCaptionIgnoresSelectedChatAndNonSpeech() {
    startCall()
    sendCaption("user", "Original spoken words")
    awaitCaption("Original spoken words")
    composeRule.runOnIdle { model.switchChatSession("agent:writer:foreign", ownerAgentId = "writer") }
    awaitUiState { model.chatSessionKey.value == "agent:writer:foreign" }
    gateway.publishTranscriptHistory("agent:writer:foreign", """[{"role":"assistant","content":[{"type":"text","text":"Unrelated selected chat text"}]}]""")
    for (role in listOf("tool", "system", "reasoning")) sendCaption(role, "Not spoken: $role")
    sendCaption("assistant", "The original call still speaks.")
    awaitCaption("The original call still speaks.")
    composeRule.onNodeWithText("scout").assertIsDisplayed()
    composeRule.onNodeWithText("Unrelated selected chat text").assertDoesNotExist()
    for (role in listOf("tool", "system", "reasoning")) composeRule.onNodeWithText("Not spoken: $role").assertDoesNotExist()
    assertEquals(
      FIRST_CHAT,
      model.talkCallPresentation.value.call
        ?.start
        ?.owner
        ?.sessionKey,
    )
    assertNoPhotoSend()
  }

  @Test
  fun layoutFollowupReplacementNeverReplaysPreviousCallCaption() {
    startCall()
    sendCaption("assistant", "Previous call private speech")
    awaitCaption("Previous call private speech")
    val first = checkNotNull(model.chatTalkCall.value).start
    composeRule.onNodeWithText("End").assertIsDisplayed().performClick()
    awaitStopped()
    sendCaption("assistant", "Retired relay callback")
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    startCall(createCount = 2)
    assertTrue(model.chatTalkCall.value?.start !== first)
    assertTrue(talkManager().conversation.value.any { it.text == "Previous call private speech" })
    composeRule.onNodeWithTag("conversation-transcript").assertDoesNotExist()
    sendCaption("user", "New call words")
    awaitCaption("New call words")
    composeRule.onNodeWithText("Previous call private speech").assertDoesNotExist()
    composeRule.onNodeWithText("Retired relay callback").assertDoesNotExist()
  }

  @Test
  fun layoutFollowupSmallViewportLargeFontKeepsEndVisible() {
    composeRule.runOnIdle {
      viewportHeight = 480.dp
      fixtureFontScale = 2f
    }
    startCall()
    val initial =
      composeRule
        .onNodeWithText("End")
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .boundsInRoot
    sendCaption("assistant", "Long spoken sentence. ".repeat(30))
    awaitCaption("Long spoken sentence. ".repeat(30), requireDisplayed = false)
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    assertEquals("Photo ready to send.", awaitPhoto(takePhoto()))
    composeRule.onNodeWithText("Send photos").performScrollTo().assertIsDisplayed()
    val current =
      composeRule
        .onNodeWithText("End")
        .assertIsDisplayed()
        .fetchSemanticsNode()
        .boundsInRoot
    assertEquals(initial, current)
    val page = composeRule.onNodeWithTag("chat-conversation-page").fetchSemanticsNode().boundsInRoot
    assertTrue(current.bottom <= page.bottom + 1f)
    captureTalkProof("layout-small-large-font")
    composeRule.onNodeWithText("End").performClick()
    awaitStopped()
  }

  @Test
  fun layoutFollowupMutedNativeReplyStillPublishesCaptionWithoutAudio() {
    val speechService = ComponentName(app, "TestSpeechRecognitionService")
    shadowOf(app.packageManager).apply {
      addServiceIfNotPresent(speechService)
      addIntentFilterForService(speechService, IntentFilter(RecognitionService.SERVICE_INTERFACE))
    }
    gateway.nativeTalk = true
    gateway.nativeAssistantReply = "{\"voice\":\"synthetic-voice\"}\nCaption while audio is off"
    val refresh = photoScope.async { talkManager().refreshConfig() }
    awaitUiState { refresh.isCompleted }
    val played = CompletableDeferred<Unit>()
    ReflectionHelpers.setField(
      talkManager(),
      "talkAudioPlayer",
      object : TalkAudioPlaying {
        override suspend fun play(audio: TalkSpeakAudio) {
          played.complete(Unit)
        }

        override fun stop() {}
      },
    )
    composeRule.onNodeWithContentDescription("Start Talk").performClick()
    awaitListening(expectChatCall = true)
    val start = checkNotNull(model.chatTalkCall.value).start
    val generation = model.talkCallPresentation.value.generation
    composeRule.onNodeWithContentDescription("Speaker audio").performClick()
    awaitUiState { !model.speakerEnabled.value }
    val recognizer = shadowOf(checkNotNull(ShadowSpeechRecognizer.getLatestSpeechRecognizer()))
    val result = Bundle().apply { putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf("Muted native question")) }
    composeRule.runOnIdle { recognizer.triggerOnPartialResults(result) }
    awaitCaption("Muted native question")
    composeRule.runOnIdle {
      recognizer.triggerOnResults(result)
      ShadowSystemClock.advanceBy(Duration.ofMillis(1200))
    }
    // Completion is the real native turn returning to listening with a new recognizer, not caption arrival.
    awaitUiState {
      gateway.requests.any { it.method == "chat.send" } &&
        model.talkModeListening.value && model.talkCallPresentation.value.generation > generation &&
        model.talkCallPresentation.value.call
          ?.start === start &&
        ShadowSpeechRecognizer.getLatestSpeechRecognizer()?.let { shadowOf(it) !== recognizer } == true
    }
    assertFalse(model.speakerEnabled.value)
    assertFalse(played.isCompleted)
    assertFalse(gateway.requests.any { it.method == "talk.speak" || it.method == "talk.session.create" || it.method == "talk.session.appendAudio" })
    assertEquals(1, gateway.requests.count { it.method == "chat.send" })
    captureTalkProof("layout-native-muted-caption")
    composeRule.onNodeWithText("Caption while audio is off").assertIsDisplayed()
    composeRule.onNodeWithText("scout").assertIsDisplayed()
    composeRule.onNodeWithText("Muted native question").assertDoesNotExist()
    composeRule.onNodeWithText(gateway.nativeAssistantReply).assertDoesNotExist()
  }

  @Test
  fun layoutFollowupNativeSpeechUsesSameCallAndRejectsRetiredRecognizer() {
    val speechService = ComponentName(app, "TestSpeechRecognitionService")
    shadowOf(app.packageManager).apply {
      addServiceIfNotPresent(speechService)
      addIntentFilterForService(speechService, IntentFilter(RecognitionService.SERVICE_INTERFACE))
    }
    gateway.nativeTalk = true
    val refresh = photoScope.async { talkManager().refreshConfig() }
    awaitUiState { refresh.isCompleted }
    val played = CompletableDeferred<Unit>()
    val finish = CompletableDeferred<Unit>()
    ReflectionHelpers.setField(
      talkManager(),
      "talkAudioPlayer",
      object : TalkAudioPlaying {
        override suspend fun play(audio: TalkSpeakAudio) {
          played.complete(Unit)
          finish.await()
        }

        override fun stop() {
          finish.complete(Unit)
        }
      },
    )
    composeRule.onNodeWithContentDescription("Start Talk").performClick()
    awaitListening(expectChatCall = true)
    val first = checkNotNull(model.chatTalkCall.value).start
    val recognizer = shadowOf(checkNotNull(ShadowSpeechRecognizer.getLatestSpeechRecognizer()))
    val result = Bundle().apply { putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf("Native spoken question")) }
    composeRule.runOnIdle { recognizer.triggerOnPartialResults(result) }
    awaitCaption("Native spoken question")
    composeRule.onNodeWithText("You").assertIsDisplayed()
    composeRule.runOnIdle {
      recognizer.triggerOnResults(result)
      ShadowSystemClock.advanceBy(Duration.ofMillis(1200))
    }
    awaitUiState { played.isCompleted }
    awaitCaption(gateway.nativeAssistantReply)
    composeRule.onNodeWithText("scout").assertIsDisplayed()
    assertEquals(
      gateway.nativeAssistantReply,
      gateway.requests
        .single { it.method == "talk.speak" }
        .params
        .getValue("text")
        .jsonPrimitive.content,
    )
    assertEquals(
      FIRST_CHAT,
      gateway.requests
        .single { it.method == "chat.send" }
        .params
        .getValue("sessionKey")
        .jsonPrimitive.content,
    )
    composeRule.runOnIdle { finish.complete(Unit) }
    awaitUiState {
      model.talkModeListening.value && model.talkCallPresentation.value.call
        ?.start === first
    }
    awaitCaption(gateway.nativeAssistantReply)
    composeRule.runOnIdle { recognizer.triggerOnPartialResults(Bundle().apply { putStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION, arrayListOf("Retired recognizer words")) }) }
    composeRule.onNodeWithText("Retired recognizer words").assertDoesNotExist()
    captureTalkProof("layout-native-caption")
    composeRule.onNodeWithText("End").assertIsDisplayed().performClick()
    awaitStopped()
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    composeRule.onNodeWithContentDescription("Start Talk").performClick()
    awaitListening(expectChatCall = true)
    assertTrue(model.chatTalkCall.value?.start !== first)
    composeRule.onNodeWithTag("conversation-transcript").assertDoesNotExist()
    assertTrue(gateway.creates.isEmpty())
  }

  private fun awaitCaption(
    text: String,
    requireDisplayed: Boolean = true,
  ) {
    awaitUiState {
      model.talkCallPresentation.value.call
        ?.utterance
        ?.text == text
    }
    if (requireDisplayed) composeRule.onNodeWithText(text).assertIsDisplayed()
  }

  @Test
  fun layoutFollowupLateUserFinalDoesNotReplaceCurrentAssistantCaption() {
    startCall()
    sendCaption("user", "Can you tack", isFinal = false)
    sendCaption("assistant", "Checking", isFinal = false)
    sendCaption("user", "Can you check?", isFinal = true)
    val manager = talkManager()
    val publicationLock = ReflectionHelpers.getField<Any>(manager, "realtimeCapturePauseLock")
    awaitUiState {
      synchronized(publicationLock) {
        manager.conversation.value.size == 2 &&
          manager.conversation.value
            .first()
            .text == "Can you check?" &&
          model.talkCallPresentation.value.call == manager.chatCall.value
      }
    }
    assertEquals(
      "Checking",
      manager.conversation.value
        .last()
        .text,
    )
    captureTalkProof("layout-late-user-final")
    composeRule.onNodeWithText("Checking").assertIsDisplayed()
    composeRule.onNodeWithText("scout").assertIsDisplayed()
    composeRule.onNodeWithText("Can you check?").assertDoesNotExist()
  }

  private fun sendCaption(
    role: String,
    text: String,
    isFinal: Boolean = true,
  ) {
    gateway.sendEvent(
      "talk.event",
      buildJsonObject {
        put("relaySessionId", "ownership-relay")
        put("type", "transcript")
        put("role", role)
        put("text", text)
        put("final", isFinal)
      }.toString(),
    )
  }

  @Test
  fun p2ConversationControlsHaveContrastInDarkAndLight() {
    startCall()
    val failures = mutableListOf<String>()
    for (dark in listOf(true, false)) {
      composeRule.runOnIdle { prefs.setAppearanceThemeMode(if (dark) AppearanceThemeMode.Dark else AppearanceThemeMode.Light) }
      composeRule.waitForIdle()
      val root = composeRule.onNodeWithTag("chat-avatar-proof")
      val page = root.captureToImage().asAndroidBitmap()
      val rootBounds = root.fetchSemanticsNode().boundsInRoot
      val canvas = android.graphics.Color.luminance(page.getPixel(0, page.height - 1))
      assertTrue("The production shell must use the requested theme", if (dark) canvas < 0.1f else canvas > 0.5f)
      captureTalkProof(if (dark) "conversation-dark" else "conversation-light")
      val nodes =
        listOf(
          "Call label" to composeRule.onNodeWithText("Call · scout"),
          "Details icon" to composeRule.onNodeWithContentDescription("Details"),
        )
      for ((label, node) in nodes) {
        val bounds = node.assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val left = (bounds.left - rootBounds.left).toInt().coerceIn(0, page.width - 1)
        val top = (bounds.top - rootBounds.top).toInt().coerceIn(0, page.height - 1)
        val right = (bounds.right - rootBounds.left).toInt().coerceIn(left + 1, page.width)
        val bottom = (bounds.bottom - rootBounds.top).toInt().coerceIn(top + 1, page.height)
        val image = Bitmap.createBitmap(page, left, top, right - left, bottom - top)
        val background = android.graphics.Color.luminance(image.getPixel(image.width - 1, 0))
        var visiblePixels = 0
        for (y in 0 until image.height) {
          for (x in 0 until image.width) {
            val luminance = android.graphics.Color.luminance(image.getPixel(x, y))
            val contrast = (maxOf(background, luminance) + 0.05f) / (minOf(background, luminance) + 0.05f)
            if (contrast >= if (label == "Call label") 4.5f else 3f) visiblePixels++
          }
        }
        if (visiblePixels < 10) failures += "$label lacks contrast (dark=$dark, pixels=$visiblePixels)"
      }
    }
    assertTrue(failures.joinToString("; "), failures.isEmpty())
  }

  @Test
  fun conversationKeepsTheCapturedOwnerAndDraftAcrossNavigation() {
    val owner = ChatComposerOwner(gateway.endpoint.stableId, "scout", FIRST_CHAT)
    composeRule.runOnIdle { model.chatComposerState.textDrafts[owner] = "Keep this unsent draft" }
    // A nonempty draft owns Send, so start through the same ViewModel admission used by the launcher.
    composeRule.runOnIdle { model.startChatTalk(checkNotNull(model.captureChatTalkStart())) }
    awaitCreate().complete()
    awaitListening(expectChatCall = true)
    selectChat(SECOND_CHAT)
    composeRule.onNodeWithContentDescription("Return to conversation").performClick()
    composeRule.onNodeWithTag("chat-conversation-page").assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Details").performClick()
    composeRule.onNodeWithText(FIRST_CHAT).assertIsDisplayed()
    composeRule.onNodeWithText("Call · scout").assertIsDisplayed()
    composeRule.onNodeWithText("Photo").assertIsNotEnabled()
    composeRule.onNodeWithText("Return to the call's chat before taking a photo.").assertIsDisplayed()
    composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
    assertEquals(SECOND_CHAT, runtime.chatSessionKey.value)
    assertEquals(1, gateway.creates.size)
    val audioBefore = prefs.speakerEnabled.value
    composeRule.onNodeWithContentDescription("Speaker audio").performClick()
    assertEquals(!audioBefore, prefs.speakerEnabled.value)
    composeRule.onNodeWithText("End").performClick()
    awaitStopped()
    awaitUiState { closes().size == 1 }
    assertEquals(
      gateway.creates
        .single()
        .request.connection,
      closes().single().connection,
    )
    assertEquals(
      "ownership-relay",
      closes()
        .single()
        .params
        .getValue("sessionId")
        .jsonPrimitive.content,
    )
    assertEquals("Keep this unsent draft", model.chatComposerState.textDrafts[owner])
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    composeRule.onNodeWithTag("chat-conversation-page").assertDoesNotExist()
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
    composeRule.onNodeWithTag("chat-conversation-page").assertIsDisplayed()
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
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    composeRule.onNodeWithTag("chat-conversation-page").assertDoesNotExist()
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
    composeRule.onNodeWithTag("chat-conversation-page").assertDoesNotExist()
    composeRule.runOnIdle { model.setForeground(false) }
    awaitStopped()
    awaitUiState { closes().isNotEmpty() }
  }

  @Test
  fun staleConversationControlsCannotStopMuteOrNavigateAReplacementWithTheSameRelayId() {
    startCall()
    val oldEndNode = composeRule.onNodeWithText("End").fetchSemanticsNode()
    val oldComposerEndNode = composeRule.onNodeWithText("Go to chat").fetchSemanticsNode()
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
    composeRule.onNodeWithContentDescription("Return to conversation").performClick()
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
  fun photoFollowupLargeCameraJpegHasWorkingPreview() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val raw = syntheticLargeChatPhotoBase64()
    assertTrue(raw.length > ai.openclaw.app.chat.CHAT_IMAGE_MAX_BASE64_CHARS)
    assertTrue(decodedBase64ByteCount(raw) < CHAT_COMPOSER_MAX_IMAGE_DECODED_BYTES)
    val bytes = android.util.Base64.decode(raw, android.util.Base64.NO_WRAP)
    val decoded = checkNotNull(android.graphics.BitmapFactory.decodeByteArray(bytes, 0, bytes.size))
    assertEquals(1024, decoded.width)
    assertEquals(768, decoded.height)
    decoded.recycle()
    val photo = takePhoto { _, _ -> CameraCaptureManager.Payload("""{"format":"jpg","base64":"$raw","width":1024,"height":768}""") }
    assertEquals("Photo ready to send.", awaitPhoto(photo))
    composeRule.onNodeWithText("camera.jpg").performScrollTo()
    awaitUiState {
      composeRule.onAllNodesWithContentDescription("image/jpeg").fetchSemanticsNodes().isNotEmpty() ||
        composeRule.onAllNodes(hasText("Unsupported attachment")).fetchSemanticsNodes().isNotEmpty()
    }
    captureTalkProof("photo-preview")
    composeRule.onNodeWithContentDescription("image/jpeg").assertIsDisplayed()
    composeRule.onNodeWithText("Unsupported attachment").assertDoesNotExist()
    val staged =
      model.chatComposerState.attachments.value
        .getValue(checkNotNull(model.chatTalkCall.value).start.owner)
        .single()
    assertTrue("Staging must preserve the camera JPEG bytes", raw == staged.base64)
    assertTrue(decodeBase64Bitmap(staged.base64, source = Base64ImageSource.Composer) != null)
    assertNoPhotoSend()
    composeRule.onNodeWithText("Send photos").performScrollTo().assertIsDisplayed()
    captureTalkProof("photo-preview")
    composeRule.onNodeWithText("Send photos").performClick()
    awaitUiState { gateway.requests.any { it.method == "chat.send" } }
    val sent = gateway.requests.single { it.method == "chat.send" }.params
    val transmitted =
      sent
        .getValue("attachments")
        .jsonArray
        .single()
        .jsonObject
        .getValue("content")
        .jsonPrimitive.content
    assertTrue("Sending must preserve the camera JPEG bytes", raw == transmitted)
  }

  @Test
  fun photoFollowupRestoredLargeImageUsesTheLocalAttachmentPreview() {
    startCall()
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val raw = syntheticLargeChatPhotoBase64()
    val restored =
      listOf(
        ai.openclaw.app.chat
          .SessionEditorAttachment("image/jpeg", raw),
      ).toPendingAttachments()
    composeRule.runOnIdle { model.chatComposerState.replaceAttachments(owner, restored) }
    composeRule.onNodeWithText("image-1").performScrollTo()
    awaitUiState { composeRule.onAllNodesWithContentDescription("image/jpeg").fetchSemanticsNodes().isNotEmpty() }
    composeRule.onNodeWithContentDescription("image/jpeg").assertIsDisplayed()
    composeRule.onNodeWithText("Unsupported attachment").assertDoesNotExist()
    assertTrue(
      raw ==
        model.chatComposerState.attachments.value
          .getValue(owner)
          .single()
          .base64,
    )
    assertNoPhotoSend()
  }

  @Test
  fun photoFollowupSendOnlyVisiblePhotosWithoutHiddenDraftOrDocument() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    val document = PendingAttachment("private-document", "hidden.txt", "text/plain", "cHJpdmF0ZQ==")
    composeRule.runOnIdle {
      model.chatComposerState.textDrafts[owner] = "Unsent private draft"
      model.chatComposerState.addAttachments(owner, listOf(document))
    }
    assertEquals("Photo ready to send.", awaitPhoto(takePhoto()))
    val photo =
      model.chatComposerState.attachments.value
        .getValue(owner)
        .single { it.mimeType == "image/jpeg" }
    composeRule.onNodeWithText("camera.jpg").performScrollTo()
    awaitUiState { composeRule.onAllNodesWithContentDescription("image/jpeg").fetchSemanticsNodes().isNotEmpty() }
    captureTalkProof("photo-send")
    model.chatError.value?.let { unrelatedError -> composeRule.onNodeWithText(unrelatedError).assertDoesNotExist() }
    assertNoPhotoSend()
    composeRule
      .onNodeWithText("Send photos")
      .performScrollTo()
      .assertIsEnabled()
    captureTalkProof("photo-send")
    composeRule.onNodeWithText("Send photos").performClick()
    awaitUiState { gateway.requests.any { it.method == "chat.send" } }
    val sent = gateway.requests.single { it.method == "chat.send" }.params
    assertEquals(FIRST_CHAT, sent.getValue("sessionKey").jsonPrimitive.content)
    assertEquals("See attached.", sent.getValue("message").jsonPrimitive.content)
    assertEquals(1, sent.getValue("attachments").jsonArray.size)
    assertEquals(
      photo.base64,
      sent
        .getValue("attachments")
        .jsonArray
        .single()
        .jsonObject
        .getValue("content")
        .jsonPrimitive.content,
    )
    assertEquals("Unsent private draft", model.chatComposerState.textDrafts[owner])
    awaitUiState { model.chatComposerState.attachments.value[owner] == listOf(document) }
    assertFalse(gateway.requests.any { it.method == "talk.client.toolCall" })
    composeRule.onNodeWithTag("chat-conversation-page").assertIsDisplayed()
  }

  @Test
  fun photoFollowupRepeatedAndStaleTapsCannotSendLaterAttachments() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    assertEquals("Photo ready to send.", awaitPhoto(takePhoto()))
    val first =
      model.chatComposerState.attachments.value
        .getValue(owner)
        .single()
    val button = composeRule.onNodeWithText("Send photos").performScrollTo()
    val staleClick = checkNotNull(button.fetchSemanticsNode().config[SemanticsActions.OnClick].action)
    val mutex = photoAdmissionMutex()
    val later = first.copy(id = "later", fileName = "later.jpg")
    try {
      button.performClick()
      awaitUiState {
        model.chatComposerState.sendStates.value[owner]
          ?.activeOperationIds
          ?.isNotEmpty() == true
      }
      button.assertIsNotEnabled()
      composeRule.runOnUiThread {
        model.chatComposerState.addAttachments(owner, listOf(later))
        model.chatComposerState.textDrafts[owner] = "Edited while sending"
        staleClick()
      }
      assertNoPhotoSend()
    } finally {
      mutex.unlock()
    }
    awaitUiState { gateway.requests.any { it.method == "chat.send" } }
    awaitUiState { model.chatComposerState.attachments.value[owner] == listOf(later) }
    composeRule.runOnUiThread { staleClick() }
    composeRule.waitForIdle()
    assertEquals(1, gateway.requests.count { it.method == "chat.send" })
    assertEquals(listOf(later), model.chatComposerState.attachments.value[owner])
    assertEquals("Edited while sending", model.chatComposerState.textDrafts[owner])
  }

  @Test
  fun photoFollowupEndBeforeAdmissionRetainsTheUnsentPhoto() =
    photoSendRetiredBeforeAdmission { start ->
      composeRule.runOnIdle { model.endChatTalk(start) }
      awaitStopped()
    }

  @Test
  fun photoFollowupReplacementCannotAdmitTheOldCallPhoto() =
    photoSendRetiredBeforeAdmission { start ->
      composeRule.runOnIdle { model.endChatTalk(start) }
      awaitStopped()
      // The composer hides its Talk launcher while admission is pending. Use the same
      // production start boundary as the existing before-frame replacement fixtures.
      composeRule.runOnUiThread { model.startChatTalk(checkNotNull(model.captureChatTalkStart())) }
      awaitCreate(2).complete()
      awaitListening(expectChatCall = true)
      assertTrue(model.chatTalkCall.value?.start !== start)
    }

  @Test
  fun photoFollowupChatRoundTripCannotAdmitCapturedSend() =
    photoSendRetiredBeforeAdmission {
      // Selection changes synchronously; its history cannot publish through our held mutex.
      composeRule.runOnIdle {
        val generation = runtime.chatSelectionGeneration.value
        model.switchChatSession(SECOND_CHAT, ownerAgentId = "scout")
        assertEquals(SECOND_CHAT, runtime.chatSessionKey.value)
        model.switchChatSession(FIRST_CHAT, ownerAgentId = "scout")
        assertEquals(FIRST_CHAT, runtime.chatSessionKey.value)
        assertEquals(generation + 2, runtime.chatSelectionGeneration.value)
      }
    }

  @Test
  fun photoFollowupForegroundRoundTripCannotAdmitCapturedSend() =
    photoSendRetiredBeforeAdmission {
      composeRule.runOnIdle {
        model.setForeground(false)
        model.setForeground(true)
      }
    }

  @Test
  fun photoFollowupSocketLossCannotAdmitCapturedSend() =
    photoSendRetiredBeforeAdmission {
      composeRule.runOnIdle { runtime.disconnect() }
      awaitUiState { !runtime.gatewayConnectionDisplay.value.isConnected }
    }

  private fun photoAdmissionMutex(): Mutex {
    val controller = ReflectionHelpers.getField<ChatController>(runtime, "chat")
    val mutex = ReflectionHelpers.getField<Mutex>(controller, "historyPublicationMutex")
    var acquired = false
    awaitUiState {
      if (!acquired) acquired = mutex.tryLock()
      acquired
    }
    return mutex
  }

  private fun photoSendRetiredBeforeAdmission(retire: (TalkModeManager.ChatStart) -> Unit) {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val start = checkNotNull(model.chatTalkCall.value).start
    val owner = start.owner
    composeRule.runOnIdle { model.chatComposerState.textDrafts[owner] = "Unsent draft" }
    assertEquals("Photo ready to send.", awaitPhoto(takePhoto()))
    val staged =
      model.chatComposerState.attachments.value
        .getValue(owner)
    val mutex = photoAdmissionMutex()
    try {
      composeRule.onNodeWithText("Send photos").performScrollTo().performClick()
      awaitUiState {
        model.chatComposerState.sendStates.value[owner]
          ?.activeOperationIds
          ?.isNotEmpty() == true
      }
      retire(start)
    } finally {
      mutex.unlock()
    }
    awaitUiState {
      model.chatComposerState.sendStates.value[owner]
        ?.activeOperationIds
        .isNullOrEmpty()
    }
    assertNoPhotoSend()
    assertEquals(staged, model.chatComposerState.attachments.value[owner])
    assertEquals("Unsent draft", model.chatComposerState.textDrafts[owner])
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
    assertEquals(
      PHOTO_BASE64,
      model.chatComposerState.attachments.value
        .getValue(owner)
        .single()
        .base64,
    )
    composeRule.onNodeWithTag("chat-conversation-page").assertIsDisplayed()
    composeRule.onNodeWithText("camera.jpg").performScrollTo().assertIsDisplayed()
    composeRule.onNodeWithContentDescription("Remove attachment").assertIsDisplayed()
    composeRule.waitUntil(TIMEOUT_MS) { composeRule.onAllNodesWithContentDescription("image/jpeg").fetchSemanticsNodes().size == 1 }
    composeRule
      .onNodeWithContentDescription("image/jpeg")
      .performScrollTo()
      .assertIsDisplayed()
      .performClick()
    composeRule.onNodeWithContentDescription("Image preview").assertIsDisplayed()
    captureTalkProof("photo-fullscreen", dialog = true)
    composeRule.onNodeWithContentDescription("Close image preview").performClick()
    composeRule.onNodeWithTag("chat-conversation-page").assertIsDisplayed()
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    composeRule.onNode(hasSetTextAction()).performTextInput("Describe this photo")
    assertEquals("Describe this photo", model.chatComposerState.textDrafts[owner])
    assertNoPhotoSend()
    composeRule.onNodeWithContentDescription("Send").assertIsEnabled().performClick()
    awaitUiState { gateway.requests.any { it.method == "chat.send" } }
    val sent = gateway.requests.single { it.method == "chat.send" }
    assertEquals(
      FIRST_CHAT,
      sent.params
        .getValue("sessionKey")
        .jsonPrimitive.content,
    )
    assertTrue(sent.params.toString().contains(PHOTO_BASE64))
    assertFalse(gateway.requests.any { it.method == "talk.client.toolCall" })
    // The fixture intentionally refuses chat.send; this proves submission, not provider analysis/TTS.
  }

  @Test
  @Config(qualifiers = "w360dp-h320dp-420dpi")
  fun compactConversationKeepsScrollablePhotoEndAndChatNavigation() {
    startCall()
    composeRule.onNode(hasSetTextAction()).assertDoesNotExist()
    composeRule
      .onNodeWithText("Photo")
      .assertIsDisplayed()
      .assertIsEnabled()
    composeRule
      .onNodeWithText("End")
      .assertIsDisplayed()
      .assertIsEnabled()
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    composeRule.onNode(hasSetTextAction()).assertIsDisplayed()
    val input = composeRule.onNodeWithTag("chat-composer-surface").fetchSemanticsNode().boundsInRoot
    val returnButton = composeRule.onNodeWithContentDescription("Return to conversation").fetchSemanticsNode().boundsInRoot
    assertTrue(returnButton.top >= input.top && returnButton.bottom <= input.bottom)
    assertTrue(runtime.talkModeEnabled.value)
  }

  @Test
  fun oldGenericEndCannotStopANewChatCall() {
    composeRule.runOnIdle { model.setTalkModeEnabled(true) }
    awaitCreate().complete()
    awaitListening()
    composeRule.onNodeWithContentDescription("Return to conversation").performClick()
    val oldEndNode = composeRule.onNodeWithText("End").fetchSemanticsNode()
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
    val photo =
      takePhoto { _, _ ->
        captures++
        photoPayload()
      }
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
    val photo =
      takePhoto { _, isCurrent ->
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
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
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
    val existing =
      List(CHAT_COMPOSER_MAX_ATTACHMENTS) { index ->
        PendingAttachment("existing-$index", "image-$index.jpg", "image/jpeg", PHOTO_BASE64)
      }
    composeRule.runOnIdle { model.chatComposerState.addAttachments(owner, existing) }
    assertEquals("Photo not added. Remove an attachment and try again.", awaitPhoto(takePhoto()))
    assertEquals(existing, model.chatComposerState.attachments.value[owner])
    assertEquals(ChatComposerAttachmentNotice.Attachment, model.chatComposerState.attachmentNotices.value[owner])
    assertFalse(model.chatComposerState.hasPendingGatewaySwitchWork(owner))
    assertNoPhotoSend()
  }

  @Test
  fun talkTapAndBackNavigateWithoutStartingOrEndingASecondCall() {
    startCall()
    val start = checkNotNull(model.chatTalkCall.value).start
    composeRule.onNodeWithTag("chat-conversation-page").assertIsDisplayed()
    composeRule.onNodeWithTag("chat-call-card").assertDoesNotExist()
    composeRule.runOnIdle { backDispatcher.onBackPressed() }
    composeRule.onNode(hasSetTextAction()).assertIsDisplayed()
    selectChat(SECOND_CHAT)
    composeRule.onNodeWithContentDescription("Return to conversation").performClick()
    assertSame(start, model.chatTalkCall.value?.start)
    assertEquals(SECOND_CHAT, runtime.chatSessionKey.value)
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    awaitUiState { runtime.chatSessionKey.value == FIRST_CHAT && model.chatSessionKey.value == FIRST_CHAT }
    composeRule.onNode(hasSetTextAction()).assertIsDisplayed()
    assertSame(start, model.chatTalkCall.value?.start)
    assertEquals(1, gateway.creates.size)
    assertTrue(closes().isEmpty())
  }

  @Test
  fun overviewTalkOpensTheSameDedicatedConversation() {
    for ((index, label) in listOf("Talk", "Open Talk").withIndex()) {
      val entry =
        if (label == "Talk") {
          hasText("Talk") and !hasText("Open Talk") and hasClickAction()
        } else {
          hasText("Open Talk") and hasClickAction()
        }
      composeRule.runOnIdle { model.requestHomeDestination(HomeDestination.Connect) }
      composeRule.onNode(entry).performScrollTo().performClick()
      captureTalkProof("overview-$index-after-tap")
      awaitCreate(index + 1).complete()
      awaitListening(expectChatCall = true)
      val start = checkNotNull(model.chatTalkCall.value).start
      captureTalkProof("overview-$index-admitted")
      composeRule.onNodeWithTag("chat-conversation-page").assertIsDisplayed()
      composeRule.runOnIdle { model.requestHomeDestination(HomeDestination.Connect) }
      composeRule.onNode(entry).performScrollTo().performClick()
      composeRule.onNodeWithTag("chat-conversation-page").assertIsDisplayed()
      assertSame(start, model.chatTalkCall.value?.start)
      assertEquals(index + 1, gateway.creates.size)
      composeRule.onNodeWithText("End").assertIsDisplayed().performClick()
      awaitStopped()
    }
  }

  @Test
  fun visibleCallPhotoRemovalTargetsTheCallOwnerWhileAnotherChatIsSelected() {
    startCall()
    shadowOf(app).grantPermissions(Manifest.permission.CAMERA)
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    assertEquals("Photo ready to send.", awaitPhoto(takePhoto()))
    val attachment =
      model.chatComposerState.attachments.value
        .getValue(owner)
        .single()
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    selectChat(SECOND_CHAT)
    val otherOwner = model.captureChatShareOwner()
    composeRule.runOnIdle { model.chatComposerState.addAttachments(otherOwner, listOf(attachment)) }
    composeRule.onNodeWithContentDescription("Return to conversation").performClick()
    composeRule
      .onNodeWithContentDescription("Remove attachment")
      .performScrollTo()
      .assertIsDisplayed()
      .assertIsEnabled()
      .performClick()
    composeRule.runOnIdle {
      assertTrue(
        model.chatComposerState.attachments.value[owner]
          .isNullOrEmpty(),
      )
      assertEquals(listOf(attachment), model.chatComposerState.attachments.value[otherOwner])
    }
    assertEquals(SECOND_CHAT, runtime.chatSessionKey.value)
    assertNoPhotoSend()
    assertEquals(1, gateway.creates.size)
  }

  @Test
  fun photoButtonKeepsBusyAndPermissionNoticeOnTheRealCapturePath() {
    startCall()
    prepareCameraPermissionPrompt()
    val owner = checkNotNull(model.chatTalkCall.value).start.owner
    composeRule
      .onNodeWithText("Selfie camera · Switch to rear")
      .assertIsDisplayed()
      .performClick()
    composeRule
      .onNodeWithText("Photo")
      .assertIsDisplayed()
      .performClick()
    awaitUiState { cameraPermissionRequests.size == 1 }
    composeRule.onNodeWithText("Photo").assertIsNotEnabled()
    composeRule.onNodeWithText("Rear camera · Switch to selfie").assertIsNotEnabled()
    composeRule.onNodeWithText("Taking photo…").assertIsDisplayed()
    captureTalkProof("photo-permission-pending")
    composeRule.runOnIdle {
      val (permissions, code) = cameraPermissionRequests.single()
      assertTrue(photoPermissions.onRequestPermissionsResult(code, permissions, intArrayOf(PackageManager.PERMISSION_DENIED)))
    }
    awaitUiState { ShadowDialog.getLatestDialog()?.isShowing == true }
    composeRule.runOnIdle {
      val dialog = checkNotNull(ShadowDialog.getLatestDialog())
      // Drive the dialog's real Back dispatch, including dismissal, not its shadow callback.
      dialog.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
      dialog.dispatchKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK))
    }
    awaitUiState { ShadowDialog.getLatestDialog()?.isShowing != true && !model.chatComposerState.hasPendingGatewaySwitchWork(owner) }
    composeRule.onNodeWithText("Camera permission required").assertIsDisplayed()
    composeRule.onNodeWithText("Photo").assertIsEnabled()
    composeRule.onNodeWithText("Rear camera · Switch to selfie").assertIsEnabled()
    assertTrue(
      model.chatComposerState.attachments.value
        .isEmpty(),
    )
    assertNoPhotoSend()
  }

  @Test
  fun cameraChoiceChangesWithoutCapturingOrSending() {
    startCall()
    composeRule.onNodeWithText("Selfie camera · Switch to rear").performClick()
    composeRule.onNodeWithText("Rear camera · Switch to selfie").assertIsDisplayed().performClick()
    composeRule.onNodeWithText("Selfie camera · Switch to rear").assertIsDisplayed()
    assertTrue(
      model.chatComposerState.attachments.value
        .isEmpty(),
    )
    assertNoPhotoSend()
    assertEquals(1, gateway.creates.size)
  }

  @Test
  fun callActivityFollowsItsRunWhileAnotherChatIsSelected() {
    startCall()
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    selectChat(SECOND_CHAT)
    composeRule.onNodeWithContentDescription("Return to conversation").performClick()
    gateway.sendEvent("talk.event", """{"relaySessionId":"ownership-relay","type":"toolCall","callId":"consult-1","name":"openclaw_agent_consult","args":{"text":"Inspect the file"}}""")
    awaitUiState { model.talkCallPresentation.value.activity == TalkAgentActivity.Thinking }
    assertFalse(model.talkCallPresentation.value.speaking)
    gateway.sendEvent("agent", """{"runId":"other-work","sessionKey":"$SECOND_CHAT","agentId":"scout","seq":1,"stream":"tool","data":{"phase":"start","toolCallId":"other-tool","name":"write"}}""")
    for ((index, entry) in listOf("read" to "Reading", "edit" to "Writing / editing", "web_search" to "Searching", "exec" to "Working with tools").withIndex()) {
      val (name, label) = entry
      gateway.sendEvent("agent", """{"runId":"call-work","sessionKey":"$FIRST_CHAT","agentId":"scout","seq":${index + 1},"stream":"tool","data":{"phase":"start","toolCallId":"owned-tool","name":"$name"}}""")
      awaitUiState { model.talkCallPresentation.value.activity == listOf(TalkAgentActivity.Reading, TalkAgentActivity.Writing, TalkAgentActivity.Searching, TalkAgentActivity.ToolWork)[index] }
      composeRule.onNodeWithText(label).assertIsDisplayed()
      assertFalse(model.talkCallPresentation.value.speaking)
    }
    gateway.sendEvent("agent", """{"runId":"call-work","sessionKey":"$FIRST_CHAT","agentId":"scout","seq":5,"stream":"lifecycle","data":{"phase":"waiting-approval","approvalId":"approval-1"}}""")
    awaitUiState { model.talkCallPresentation.value.activity == TalkAgentActivity.WaitingForApproval }
    composeRule.onNodeWithText("Waiting for approval").assertIsDisplayed()
    gateway.sendEvent("agent", """{"runId":"call-work","sessionKey":"$FIRST_CHAT","agentId":"scout","seq":6,"stream":"lifecycle","data":{"phase":"approval-resolved","approvalId":"approval-1"}}""")
    val expires = System.currentTimeMillis() + 60_000
    gateway.sendEvent("question.requested", """{"id":"question-1","questions":[],"runId":"call-work","sessionKey":"$FIRST_CHAT","agentId":"scout","status":"pending","createdAtMs":0,"expiresAtMs":$expires}""")
    awaitUiState { model.talkCallPresentation.value.activity == TalkAgentActivity.WaitingForInput }
    composeRule.onNodeWithText("Waiting for input").assertIsDisplayed()
    gateway.sendEvent("question.resolved", """{"id":"question-1","status":"answered"}""")
    gateway.sendEvent("agent", """{"runId":"call-work","sessionKey":"$FIRST_CHAT","agentId":"scout","seq":7,"stream":"lifecycle","data":{"phase":"error"}}""")
    awaitUiState { model.talkCallPresentation.value.activity == TalkAgentActivity.Error }
    composeRule.onNodeWithText("Agent work failed. Check the chat for details.").assertIsDisplayed()
    assertEquals(SECOND_CHAT, runtime.chatSessionKey.value)
  }

  @Test
  fun finalizedTalkHistoryUsesCanonicalRolesWithoutClientMirroringOrExtraTurns() {
    startCall()
    gateway.sendEvent("talk.event", """{"relaySessionId":"ownership-relay","type":"transcript","role":"user","text":"Spoken question","final":true}""")
    gateway.sendEvent("talk.event", """{"relaySessionId":"ownership-relay","type":"transcript","role":"assistant","text":"Spoken answer","final":true}""")
    composeRule.onNodeWithText("Go to chat").assertIsDisplayed().performClick()
    val playback = ReflectionHelpers.getField<java.util.concurrent.atomic.AtomicLong>(talkManager(), "playbackGeneration")
    val generation = playback.get()
    composeRule.runOnIdle { talkManager().ttsOnAllResponses = true }
    // The observer's early return must not consume NodeRuntime's separate ChatController ingress.
    val final = """{"sessionKey":"$FIRST_CHAT","agentId":"scout","runId":"provider-history","seq":1,"state":"final","message":{"role":"assistant","content":[{"type":"text","text":"Spoken answer"}]}}"""
    gateway.sendEvent("chat", final)
    gateway.sendEvent("chat", final)
    val rows = """[{"id":"voice-user-1","role":"user","content":[{"type":"text","text":"Spoken question"}]},{"id":"voice-assistant-1","role":"assistant","content":[{"type":"text","text":"Spoken answer"}]}]"""
    gateway.publishTranscriptHistory(FIRST_CHAT, rows)
    awaitUiState { model.chatMessages.value.size == 2 }
    gateway.publishTranscriptHistory(FIRST_CHAT, rows)
    composeRule.onNodeWithText("Spoken question").assertIsDisplayed()
    composeRule.onNodeWithText("Spoken answer").assertIsDisplayed()
    assertEquals(listOf("user", "assistant"), model.chatMessages.value.map { it.role })
    assertEquals(2, model.chatMessages.value.size)
    assertEquals("Observed finals cannot start a second speech owner", generation, playback.get())
    assertNoPhotoSend()
    assertEquals(1, gateway.creates.size)
  }

  @Test
  fun unexpectedOperatorDisconnectTerminatesBackgroundCallWithoutRestart() {
    startCall()
    composeRule.runOnIdle { model.setForeground(false) }
    gateway.dropOperatorConnection()
    awaitStopped()
    assertFalse(runtime.talkModeSpeaking.value)
    assertTrue(model.talkModeStatusText.value.contains("Gateway disconnected"))
    composeRule.runOnIdle { model.setForeground(true) }
    assertEquals(1, gateway.creates.size)
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
    composeRule.runOnIdle { result = photoScope.async { model.stageChatTalkPhoto(start, capturePhoto = capture) } }
    return result
  }

  private fun awaitPhoto(photo: Deferred<NativeText>): String {
    awaitUiState { photo.isCompleted }
    return runBlocking { photo.await() }.resolveNativeText()
  }

  private fun assertPhotoRetired(owner: ChatComposerOwner) {
    assertTrue(
      model.chatComposerState.attachments.value
        .isEmpty(),
    )
    assertFalse(model.chatComposerState.hasPendingGatewaySwitchWork(owner))
    assertNoPhotoSend()
  }

  private fun assertNoPhotoSend() {
    assertFalse(gateway.requests.any { it.method == "chat.send" || it.method == "talk.client.toolCall" })
  }

  private fun photoPayload() = CameraCaptureManager.Payload("""{"format":"jpg","base64":"$PHOTO_BASE64","width":120,"height":80}""")

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
        (
          !expectChatCall || (
            call != null && call.start === runtime.chatTalkCall.value?.start &&
              model.talkCallPresentation.value.call
                ?.start === call.start
          )
        )
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

  private fun captureTalkProof(
    name: String,
    dialog: Boolean = false,
  ) {
    val directory = System.getenv("OPENCLAW_TALK_PROOF_DIR") ?: return
    val folder = File(directory)
    check(folder.isDirectory || folder.mkdirs())
    val root = if (dialog) composeRule.onNode(isDialog()) else composeRule.onNodeWithTag("chat-avatar-proof")
    val image = root.captureToImage().asAndroidBitmap()
    assertTrue("Capture the complete production tree", image.width > 0 && image.height > 0)
    File(folder, "$name.png").outputStream().use { output ->
      assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, output))
    }
  }

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
    val PHOTO_BASE64: String by lazy { syntheticChatPhotoBase64() }
  }
}

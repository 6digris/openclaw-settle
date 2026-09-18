package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.gatewayTalkSetupDescription
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.requiresSetup
import ai.openclaw.app.voice.TalkModeManager
import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat

internal enum class ChatRealtimeTalkLaunch {
  RequestPermission,
  ShowSetupMessage,
  StartTalk,
}

/** Resolves the only side effect a Live Talk tap may perform. */
internal fun resolveChatRealtimeTalkLaunch(
  hasMicPermission: Boolean,
  requiresSetup: Boolean,
): ChatRealtimeTalkLaunch =
  when {
    !hasMicPermission -> ChatRealtimeTalkLaunch.RequestPermission
    requiresSetup -> ChatRealtimeTalkLaunch.ShowSetupMessage
    else -> ChatRealtimeTalkLaunch.StartTalk
  }

@Composable
internal fun rememberChatRealtimeTalkLauncher(viewModel: MainViewModel): () -> Unit {
  val context = LocalContext.current
  val talkSetupReadiness by viewModel.talkSetupReadiness.collectAsState()
  val currentTalkSetup by rememberUpdatedState(talkSetupReadiness.realtimeTalk)
  var pendingStart by remember(viewModel) { mutableStateOf<TalkModeManager.ChatStart?>(null) }
  val showSetupMessage = {
    Toast
      .makeText(context, gatewayTalkSetupDescription(currentTalkSetup), Toast.LENGTH_LONG)
      .show()
  }
  val requestMicPermission =
    rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
      val start = pendingStart
      pendingStart = null
      if (!granted || start == null || !start.isCurrent()) return@rememberLauncherForActivityResult
      if (currentTalkSetup.requiresSetup) {
        showSetupMessage()
      } else {
        viewModel.startChatTalk(start)
      }
    }

  return launchTalk@{
    if (pendingStart != null || viewModel.voiceCaptureMode.value == ai.openclaw.app.VoiceCaptureMode.TalkMode) return@launchTalk
    val action =
      resolveChatRealtimeTalkLaunch(
        hasMicPermission = context.hasRecordAudioPermission(),
        requiresSetup = talkSetupReadiness.realtimeTalk.requiresSetup,
      )
    if (action == ChatRealtimeTalkLaunch.ShowSetupMessage) {
      showSetupMessage()
      return@launchTalk
    }
    // Permission belongs to this tap, not whichever chat is visible when Android replies.
    val start = viewModel.captureChatTalkStart()
    if (start == null) {
      val message =
        if (currentTalkSetup.requiresSetup) {
          gatewayTalkSetupDescription(currentTalkSetup)
        } else {
          nativeText("Talk is not ready. Check the Gateway connection and try again.").resolveNativeText()
        }
      Toast.makeText(context, message, Toast.LENGTH_LONG).show()
      return@launchTalk
    }
    if (action == ChatRealtimeTalkLaunch.RequestPermission) {
      pendingStart = start
      requestMicPermission.launch(Manifest.permission.RECORD_AUDIO)
    } else {
      viewModel.startChatTalk(start)
    }
  }
}

private fun Context.hasRecordAudioPermission(): Boolean = ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

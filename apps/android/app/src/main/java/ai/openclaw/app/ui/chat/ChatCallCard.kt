package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.MascotMood
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.voice.TalkModeManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Body language follows capture/agent/playout facts, not guessed speech or phoneme timing. */
internal fun chatCallMascotMood(
  listening: Boolean,
  thinking: Boolean,
  speaking: Boolean,
): MascotMood =
  when {
    speaking -> MascotMood.Happy
    thinking -> MascotMood.Thinking
    listening -> MascotMood.Attentive
    else -> MascotMood.Idle
  }

/** The active call shares the composer's auxiliary area; text, previews and Send stay usable. */
@Composable
internal fun ChatCallCard(
  viewModel: MainViewModel,
  call: TalkModeManager.ChatCall,
  photoOwnerReady: Boolean,
  onOpenDetails: () -> Unit,
) {
  val listening by viewModel.talkModeListening.collectAsState()
  val thinking by viewModel.talkAwaitingAgent.collectAsState()
  val speaking by viewModel.talkModeSpeaking.collectAsState()
  val status by viewModel.talkModeStatusText.collectAsState()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val scope = rememberCoroutineScope()
  var takingPhoto by remember(call.start) { mutableStateOf(false) }
  var photoNotice by remember(call.start) { mutableStateOf<NativeText?>(null) }
  val photoUnavailable =
    when {
      !photoOwnerReady -> nativeString("Return to the call's chat before taking a photo.")
      !cameraEnabled -> nativeString("Enable Camera in Settings before taking a photo.")
      else -> null
    }
  val audioDescription = nativeString("Speaker audio")
  val audioState = if (speakerEnabled) nativeString("On") else nativeString("Off")

  ClawPanel(modifier = Modifier.testTag("chat-call-card")) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      // Existing geometry, animator and Android remove-animations behavior; no avatar engine.
      OpenClawMascot(
        modifier = Modifier.size(48.dp),
        mood = chatCallMascotMood(listening, thinking, speaking),
      )
      Column(modifier = Modifier.weight(1f)) {
        Text(
          text = nativeString("Call") + " · " + call.start.owner.agentId,
          style = ClawTheme.type.label,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(
          text = call.start.owner.sessionKey,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
        Text(text = status, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      }
      IconButton(onClick = onOpenDetails) {
        Icon(Icons.Default.MoreVert, contentDescription = nativeString("Details"))
      }
    }
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      TextButton(
        onClick = { viewModel.toggleChatTalkAudio(call.start) },
        modifier = Modifier.weight(1f).semantics {
          contentDescription = audioDescription
          stateDescription = audioState
        },
      ) {
        Icon(
          if (speakerEnabled) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
          contentDescription = null,
          modifier = Modifier.size(18.dp),
        )
        Text(nativeString("Audio"))
      }
      TextButton(
        modifier = Modifier.weight(1f),
        enabled = photoUnavailable == null && !takingPhoto,
        onClick = {
          if (!takingPhoto) {
            takingPhoto = true
            photoNotice = null
            scope.launch {
              try {
                photoNotice = viewModel.stageChatTalkPhoto(call.start)
              } catch (error: CancellationException) {
                throw error
              } catch (error: Exception) {
                photoNotice =
                  if (error.message?.startsWith("CAMERA_BUSY:") == true) {
                    nativeText("Camera is busy. Wait for the current capture and try again.")
                  } else {
                    nativeText("Photo not added. Check camera access and try again.")
                  }
              } finally {
                takingPhoto = false
              }
            }
          }
        },
      ) {
        Icon(Icons.Default.CameraAlt, contentDescription = null, modifier = Modifier.size(18.dp))
        Text(nativeString("Photo"))
      }
      TextButton(onClick = { viewModel.endChatTalk(call.start) }, modifier = Modifier.weight(1f)) {
        Icon(Icons.Default.CallEnd, contentDescription = null, tint = ClawTheme.colors.danger, modifier = Modifier.size(18.dp))
        Text(nativeString("End"), color = ClawTheme.colors.danger)
      }
    }
    (if (takingPhoto) nativeString("Taking photo…") else photoNotice?.resolveNativeText() ?: photoUnavailable)?.let { notice ->
      Text(text = notice, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

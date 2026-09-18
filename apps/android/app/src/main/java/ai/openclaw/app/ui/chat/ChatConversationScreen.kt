package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.MascotMood
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.voice.TalkAgentActivity
import ai.openclaw.app.voice.TalkModeManager
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
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

private fun conversationStatus(presentation: TalkModeManager.CallPresentation): NativeText =
  when {
    presentation.failed -> {
      presentation.status
    }

    presentation.activity == TalkAgentActivity.WaitingForApproval -> {
      nativeText("Waiting for approval")
    }

    presentation.activity == TalkAgentActivity.WaitingForInput -> {
      nativeText("Waiting for input")
    }

    presentation.speaking -> {
      nativeText("Speaking")
    }

    else -> {
      when (presentation.activity) {
        TalkAgentActivity.Reading -> nativeText("Reading")
        TalkAgentActivity.Writing -> nativeText("Writing / editing")
        TalkAgentActivity.Searching -> nativeText("Searching")
        TalkAgentActivity.ToolWork -> nativeText("Working with tools")
        TalkAgentActivity.Thinking -> nativeText("Thinking…")
        TalkAgentActivity.Error -> nativeText("Agent work failed. Check the chat for details.")
        TalkAgentActivity.Waiting -> nativeText("Waiting for work to resume")
        else -> presentation.status
      }
    }
  }

/** Transient shell page; the runtime, not this composition, owns the call. */
@Composable
internal fun ChatConversationScreen(
  viewModel: MainViewModel,
  onGoToChat: () -> Unit,
  onStartTalk: () -> Unit,
) {
  val presentation by viewModel.talkCallPresentation.collectAsState()
  val enabled by viewModel.talkModeEnabled.collectAsState()
  val mode by viewModel.voiceCaptureMode.collectAsState()
  val end = viewModel.captureTalkEndAction(presentation.generation)
  ClawScaffold {
    CompositionLocalProvider(LocalContentColor provides ClawTheme.colors.text) {
      Column(
        modifier = Modifier.fillMaxSize().testTag("chat-conversation-page").verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.sm),
      ) {
        val current = presentation.call
        TextButton(onClick = {
          if (current == null || viewModel.returnToChatTalkOwner(current.start)) onGoToChat()
        }) { Text(nativeString("Go to chat")) }
        if (current != null) {
          key(current.start) { ChatConversationContent(viewModel, current, presentation) }
        } else {
          OpenClawMascot(modifier = Modifier.size(240.dp))
          Text(presentation.status.resolveNativeText(), style = ClawTheme.type.title)
          if (enabled || mode == ai.openclaw.app.VoiceCaptureMode.TalkMode) {
            TextButton(onClick = end) { Text(nativeString("End")) }
          } else {
            TextButton(onClick = onStartTalk) { Text(nativeString("Start Talk")) }
          }
        }
      }
    }
  }
}

/** Capture controls are keyed to the admitted ChatStart, never a reusable relay ID. */
@Composable
private fun ChatConversationContent(
  viewModel: MainViewModel,
  call: TalkModeManager.ChatCall,
  presentation: TalkModeManager.CallPresentation,
) {
  val listening = presentation.listening
  val thinking = presentation.thinking
  val speaking = presentation.speaking
  val status = conversationStatus(presentation).resolveNativeText()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val selectedSession by viewModel.chatSessionKey.collectAsState()
  val selectedAgent by viewModel.chatSessionOwnerAgentId.collectAsState()
  val attachmentsByOwner by viewModel.chatComposerState.attachments.collectAsState()
  val photoOwnerReady =
    selectedSession == call.start.owner.sessionKey &&
      selectedAgent == call.start.owner.agentId && viewModel.isCurrentChatComposerOwner(call.start.owner)
  val attachments = attachmentsByOwner[call.start.owner].orEmpty()
  var frontCamera by remember(call.start) { mutableStateOf(true) }
  var details by remember(call.start) { mutableStateOf(false) }
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

  Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
    // Existing geometry, animator and Android remove-animations behavior; no avatar engine.
    OpenClawMascot(
      modifier = Modifier.size(240.dp).testTag("conversation-mascot").semantics { stateDescription = status },
      contentDescription = nativeString("OpenClaw"),
      speaking = speaking,
      mood =
        if (presentation.failed || presentation.activity == TalkAgentActivity.Error) {
          MascotMood.Sad
        } else if (presentation.activity in setOf(TalkAgentActivity.Reading, TalkAgentActivity.Writing, TalkAgentActivity.Searching, TalkAgentActivity.ToolWork) && !speaking) {
          MascotMood.Working
        } else {
          chatCallMascotMood(listening, thinking, speaking)
        },
    )
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
      Text(
        text = nativeString("Call") + " · " + call.start.owner.agentId,
        style = ClawTheme.type.label,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
      )
      if (details) {
        Text(
          text = call.start.owner.sessionKey,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.textMuted,
          maxLines = 1,
          overflow = TextOverflow.Ellipsis,
        )
      }
      Text(text = status, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
      if (presentation.activityIncomplete || presentation.activity == TalkAgentActivity.Unknown) {
        Text(nativeString("Activity details may be incomplete."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
      }
    }
    IconButton(onClick = { details = !details }) {
      Icon(Icons.Default.MoreVert, contentDescription = nativeString("Details"))
    }
    Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
      TextButton(
        onClick = { viewModel.toggleChatTalkAudio(call.start) },
        modifier =
          Modifier.weight(1f).semantics {
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
            val facing = if (frontCamera) "front" else "back"
            takingPhoto = true
            photoNotice = null
            scope.launch {
              try {
                photoNotice = viewModel.stageChatTalkPhoto(call.start, facing = facing)
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
    TextButton(enabled = !takingPhoto, onClick = { frontCamera = !frontCamera }) {
      Text(if (frontCamera) nativeString("Selfie camera · Switch to rear") else nativeString("Rear camera · Switch to selfie"))
    }
    if (attachments.isNotEmpty()) {
      AttachmentStrip(attachments = attachments, onRemoveAttachment = { id ->
        viewModel.removeChatTalkAttachment(call.start, id)
      })
      Text(nativeString("Go to chat to add a message and send."), style = ClawTheme.type.caption)
    }
    (if (takingPhoto) nativeString("Taking photo…") else photoNotice?.resolveNativeText() ?: photoUnavailable)?.let { notice ->
      Text(text = notice, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    }
  }
}

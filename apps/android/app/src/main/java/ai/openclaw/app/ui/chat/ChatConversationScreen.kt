package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.i18n.NativeText
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.i18n.nativeText
import ai.openclaw.app.i18n.resolveNativeText
import ai.openclaw.app.ui.design.ClawPanel
import ai.openclaw.app.ui.design.ClawPlainIconButton
import ai.openclaw.app.ui.design.ClawScaffold
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.design.MascotMood
import ai.openclaw.app.ui.design.OpenClawMascot
import ai.openclaw.app.voice.TalkAgentActivity
import ai.openclaw.app.voice.TalkModeManager
import ai.openclaw.app.voice.VoiceConversationRole
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.VolumeOff
import androidx.compose.material.icons.automirrored.filled.VolumeUp
import androidx.compose.material.icons.filled.CallEnd
import androidx.compose.material.icons.filled.CameraAlt
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** Body language follows capture/agent/playout facts, not guessed speech or phoneme timing. */
internal fun chatCallMascotMood(presentation: TalkModeManager.CallPresentation): MascotMood =
  when {
    presentation.failed || presentation.activity == TalkAgentActivity.Error -> MascotMood.Sad
    presentation.speaking -> MascotMood.Happy
    presentation.activity in setOf(TalkAgentActivity.Reading, TalkAgentActivity.Writing, TalkAgentActivity.Searching, TalkAgentActivity.ToolWork) -> MascotMood.Working
    presentation.thinking -> MascotMood.Thinking
    presentation.listening -> MascotMood.Attentive
    else -> MascotMood.Idle
  }

private fun conversationStatus(presentation: TalkModeManager.CallPresentation): NativeText {
  val activity = presentation.activity
  return when {
    presentation.failed -> presentation.status
    activity == TalkAgentActivity.WaitingForApproval -> nativeText("Waiting for approval")
    activity == TalkAgentActivity.WaitingForInput -> nativeText("Waiting for input")
    presentation.speaking -> nativeText("Speaking")
    activity == TalkAgentActivity.Reading -> nativeText("Reading")
    activity == TalkAgentActivity.Writing -> nativeText("Writing / editing")
    activity == TalkAgentActivity.Searching -> nativeText("Searching")
    activity == TalkAgentActivity.ToolWork -> nativeText("Working with tools")
    activity == TalkAgentActivity.Thinking -> nativeText("Thinking…")
    activity == TalkAgentActivity.Error -> nativeText("Agent work failed. Check the chat for details.")
    activity == TalkAgentActivity.Waiting -> nativeText("Waiting for work to resume")
    else -> presentation.status
  }
}

/** Transient shell page; the runtime, not this composition, owns the call. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChatConversationScreen(
  viewModel: MainViewModel,
  onGoToChat: () -> Unit,
  onStartTalk: () -> Unit,
) {
  val presentation by viewModel.talkCallPresentation.collectAsState()
  val enabled by viewModel.talkModeEnabled.collectAsState()
  val mode by viewModel.voiceCaptureMode.collectAsState()
  val current = presentation.call
  var details by remember(current?.start) { mutableStateOf(false) }
  val end = viewModel.captureTalkEndAction(presentation.generation)
  ClawScaffold {
    CompositionLocalProvider(LocalContentColor provides ClawTheme.colors.text) {
      Column(Modifier.fillMaxSize().testTag("chat-conversation-page"), verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xs)) {
        Row(Modifier.fillMaxWidth().testTag("conversation-header"), verticalAlignment = Alignment.CenterVertically) {
          ClawPlainIconButton(Icons.AutoMirrored.Filled.ArrowBack, nativeString("Go to chat"), {
            if (current == null || viewModel.returnToChatTalkOwner(current.start)) onGoToChat()
          })
          Text(
            current?.start?.owner?.agentId ?: nativeString("Call"),
            modifier = Modifier.weight(1f),
            style = ClawTheme.type.section,
            textAlign = TextAlign.Center,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
          )
          ClawPlainIconButton(Icons.Default.MoreVert, nativeString("Details"), { details = true }, enabled = current != null)
        }
        if (current != null) {
          key(current.start) { ChatConversationContent(viewModel, current, presentation, Modifier.weight(1f)) }
        } else {
          BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
            val avatarSize = minOf(216.dp, maxWidth, maxHeight * 0.6f)
            Column(
              Modifier.fillMaxSize().verticalScroll(rememberScrollState()).heightIn(min = maxHeight),
              horizontalAlignment = Alignment.CenterHorizontally,
              verticalArrangement = Arrangement.Center,
            ) {
              OpenClawMascot(modifier = Modifier.size(avatarSize))
              Text(presentation.status.resolveNativeText(), style = ClawTheme.type.body, textAlign = TextAlign.Center)
            }
          }
          TextButton(
            onClick = if (enabled || mode == ai.openclaw.app.VoiceCaptureMode.TalkMode) end else onStartTalk,
            modifier = Modifier.align(Alignment.CenterHorizontally),
          ) {
            Text(if (enabled || mode == ai.openclaw.app.VoiceCaptureMode.TalkMode) nativeString("End") else nativeString("Start Talk"))
          }
        }
      }
      if (details && current != null) {
        ModalBottomSheet(
          onDismissRequest = { details = false },
          sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
          containerColor = ClawTheme.colors.surface,
          contentColor = ClawTheme.colors.text,
        ) {
          Column(
            Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(ClawTheme.spacing.lg),
            verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.sm),
          ) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
              Text(nativeString("Details"), style = ClawTheme.type.title)
              TextButton(onClick = { details = false }) { Text(nativeString("Close")) }
            }
            Text(current.start.owner.sessionKey, style = ClawTheme.type.body)
            Text(conversationStatus(presentation).resolveNativeText(), style = ClawTheme.type.body)
            if (presentation.activityIncomplete || presentation.activity == TalkAgentActivity.Unknown) {
              Text(nativeString("Activity details may be incomplete."), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
            }
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
  modifier: Modifier,
) {
  val status = conversationStatus(presentation).resolveNativeText()
  val speakerEnabled by viewModel.speakerEnabled.collectAsState()
  val cameraEnabled by viewModel.cameraEnabled.collectAsState()
  val selectedSession by viewModel.chatSessionKey.collectAsState()
  val selectedAgent by viewModel.chatSessionOwnerAgentId.collectAsState()
  val attachmentsByOwner by viewModel.chatComposerState.attachments.collectAsState()
  val sendStates by viewModel.chatComposerState.sendStates.collectAsState()
  val chatError by viewModel.chatError.collectAsState()
  val photoOwnerReady =
    selectedSession == call.start.owner.sessionKey &&
      selectedAgent == call.start.owner.agentId && viewModel.isCurrentChatComposerOwner(call.start.owner)
  val photos = attachmentsByOwner[call.start.owner].orEmpty().filter { it.mimeType.startsWith("image/") }
  val sending = call.start.owner in sendStates
  val admissions = sendStates[call.start.owner]?.pendingAdmissionIds.orEmpty()
  LaunchedEffect(call.start, admissions) {
    admissions.forEach { viewModel.acknowledgeChatComposerSendAdmission(call.start.owner, it) }
  }
  var frontCamera by remember(call.start) { mutableStateOf(true) }
  val scope = rememberCoroutineScope()
  var takingPhoto by remember(call.start) { mutableStateOf(false) }
  var photoNotice by remember(call.start) { mutableStateOf<NativeText?>(null) }
  var photoSendAttempted by remember(call.start) { mutableStateOf(false) }
  val photoUnavailable =
    when {
      !photoOwnerReady -> nativeString("Return to the call's chat before taking a photo.")
      !cameraEnabled -> nativeString("Enable Camera in Settings before taking a photo.")
      else -> null
    }
  val audioDescription = nativeString("Speaker audio")
  val audioState = if (speakerEnabled) nativeString("On") else nativeString("Off")

  BoxWithConstraints(modifier = modifier.fillMaxWidth()) {
    val mediaHeight = maxHeight * 0.45f
    Column(Modifier.fillMaxSize()) {
      BoxWithConstraints(Modifier.weight(1f).fillMaxWidth()) {
        val avatarSize = minOf(216.dp, maxWidth, maxHeight * 0.6f)
        Column(
          Modifier.fillMaxSize().verticalScroll(rememberScrollState()).heightIn(min = maxHeight),
          horizontalAlignment = Alignment.CenterHorizontally,
          verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.sm, Alignment.CenterVertically),
        ) {
          // Existing geometry, animator and Android remove-animations behavior; no avatar engine.
          OpenClawMascot(
            modifier = Modifier.size(avatarSize).testTag("conversation-mascot").semantics { stateDescription = status },
            contentDescription = nativeString("OpenClaw"),
            speaking = presentation.speaking,
            mood = chatCallMascotMood(presentation),
          )
          Text(
            status,
            style = ClawTheme.type.body,
            color = if (presentation.failed || presentation.activity == TalkAgentActivity.Error) ClawTheme.colors.danger else ClawTheme.colors.textMuted,
            textAlign = TextAlign.Center,
          )
          call.utterance?.let { utterance ->
            ClawPanel(Modifier.testTag("conversation-caption-card")) {
              Text(
                if (utterance.role == VoiceConversationRole.User) nativeString("You") else nativeString("Assistant"),
                modifier = Modifier.padding(bottom = ClawTheme.spacing.xxxs).testTag("conversation-speaker"),
                style = ClawTheme.type.caption,
                color = ClawTheme.colors.textMuted,
              )
              Text(
                utterance.text,
                modifier = Modifier.fillMaxWidth().testTag("conversation-transcript"),
                style = ClawTheme.type.body,
                maxLines = 4,
                overflow = TextOverflow.Ellipsis,
              )
            }
          }
        }
      }
      HorizontalDivider(color = ClawTheme.colors.border)
      Column(
        Modifier
          .fillMaxWidth()
          .heightIn(max = mediaHeight)
          .verticalScroll(rememberScrollState())
          .testTag("conversation-photo-zone"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxxs),
      ) {
        TextButton(enabled = !takingPhoto, onClick = { frontCamera = !frontCamera }) {
          Text(if (frontCamera) nativeString("Selfie camera · Switch to rear") else nativeString("Rear camera · Switch to selfie"), maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (photos.isNotEmpty()) {
          AttachmentStrip(attachments = photos, onRemoveAttachment = { id ->
            viewModel.removeChatTalkAttachment(call.start, id)
          })
          TextButton(
            enabled = photoOwnerReady && !takingPhoto && !sending && !viewModel.chatComposerState.hasPendingImport(call.start.owner),
            onClick = {
              when (viewModel.beginChatTalkPhotoSend(call.start, photos)) {
                ChatComposerSendStartResult.Started -> {
                  photoNotice = null
                  photoSendAttempted = true
                }

                ChatComposerSendStartResult.CheckpointFull, ChatComposerSendStartResult.MessageTooLong -> {
                  photoNotice = nativeText("Photo not sent. Try again.")
                }

                ChatComposerSendStartResult.Unavailable -> {
                  // A busy or retired callback must leave the staged photos untouched.
                }
              }
            },
          ) { Text(nativeString("Send photos")) }
        }
        if (photoSendAttempted && photoOwnerReady && !sending && photos.isNotEmpty()) {
          chatError?.takeIf { it.isNotBlank() }?.let {
            Text(it, style = ClawTheme.type.caption, color = ClawTheme.colors.danger)
          }
        }
        (if (takingPhoto) nativeString("Taking photo…") else photoNotice?.resolveNativeText() ?: photoUnavailable)?.let { notice ->
          Text(text = notice, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
        }
      }
      Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxs)) {
        ConversationAction(
          text = nativeString("Audio"),
          icon = if (speakerEnabled) Icons.AutoMirrored.Filled.VolumeUp else Icons.AutoMirrored.Filled.VolumeOff,
          onClick = { viewModel.toggleChatTalkAudio(call.start) },
          modifier =
            Modifier.weight(1f).semantics {
              contentDescription = audioDescription
              stateDescription = audioState
            },
        )
        ConversationAction(
          text = nativeString("Photo"),
          icon = Icons.Default.CameraAlt,
          modifier = Modifier.weight(1f),
          enabled = photoUnavailable == null && !takingPhoto,
          onClick = {
            if (!takingPhoto) {
              val facing = if (frontCamera) "front" else "back"
              takingPhoto = true
              photoNotice = null
              photoSendAttempted = false
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
        )
        ConversationAction(
          text = nativeString("End"),
          icon = Icons.Default.CallEnd,
          onClick = { viewModel.endChatTalk(call.start) },
          modifier = Modifier.weight(1f),
          destructive = true,
        )
      }
    }
  }
}

@Composable
private fun ConversationAction(
  text: String,
  icon: ImageVector,
  onClick: () -> Unit,
  modifier: Modifier = Modifier,
  enabled: Boolean = true,
  destructive: Boolean = false,
) {
  TextButton(
    onClick = onClick,
    modifier = modifier,
    enabled = enabled,
    contentPadding = PaddingValues(horizontal = ClawTheme.spacing.xxxs, vertical = ClawTheme.spacing.xxs),
  ) {
    val color = if (destructive) ClawTheme.colors.danger else LocalContentColor.current
    Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(ClawTheme.spacing.xxxs)) {
      Icon(icon, contentDescription = null, tint = color, modifier = Modifier.size(ClawTheme.spacing.icon))
      Text(text, color = color, style = ClawTheme.type.caption, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
  }
}

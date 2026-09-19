---
summary: "Talk controls and behavior in the macOS, Apple Watch, and Android clients"
read_when:
  - Using Talk from the macOS menu bar or overlay
  - Setting up standalone voice on Apple Watch
  - Using dictation, voice notes, or Talk on Android
title: "Talk client UI"
sidebarTitle: "Client UI"
---

## macOS UI

- Menu bar: **Voice & Talk Settings…** opens the native **Voice & Talk** settings page.
- Native settings: **Use realtime Gateway relay** is a local, default-off opt-in for this Mac.
- **Open in Dashboard** hands provider, model, voice, and transport setup to Control UI **Settings → Talk** under **Connections**.
- Menu bar: **Talk Mode** starts or stops the current Talk session.
- Overlay: the orb renders the universal talk waveform (shared with iOS, watchOS, and Android). Listening follows the live mic level, Speaking follows the actual TTS playback envelope, Thinking breathes softly. Click the orb to pause/resume, double-click to stop speaking, click X to exit Talk mode.

## Apple Watch UI

Tap **Connect Apple Watch** in iPhone **Settings → Apple Watch**, then open
**Talk on Watch** and tap **Start**. Voice is included without a separate enable
setting; setup alone does not activate the microphone. The Watch asks you to choose an agent when
more than one is available, creates a separate chat for the call, and shows
the latest speech transcripts with **Mute** and **End** controls. It does not run
the agent or stock Codex runtime locally.

Keep the app in the foreground until connected. Established calls use
background audio; an unfinished startup stops if backgrounded. Physical
wrist-down, speaker routing, cellular handoff, and long-call endurance remain
unverified. Simulator results and macOS provider-audio probes are not proof of
Watch background behavior. See [Watch setup and limits](/platforms/ios#standalone-voice).

## Android UI

- Android's main navigation is **Home**, **Chat**, and **Settings**. Voice input
  lives in the Chat composer rather than a separate Voice tab.
- Tap the composer microphone for on-device dictation. Long-press it to record
  a voice-note attachment. Start continuous Talk from the Talk waveform.
- Talk opens a dedicated conversation page with the existing animated mascot.
  Its speaking mouth follows audio playback, not text generation. The closed
  mouth remains visible between replies and with reduced motion enabled. Tapping Talk
  during a call returns to that page without starting another call. **Go to chat**
  opens the call's original agent/session; Android Back changes only the view.
  **End** closes audio and is separate from the chat agent's **Stop** action.
  The smaller avatar sits below a header with the captured agent identity,
  **Go to chat**, and **Details**. Audio, photo, and End controls stay at the
  bottom inside the safe area. Camera choice, previews, and explicit Send photos
  share a scrollable photo area above those fixed actions. A compact, read-only caption shows up to
  four lines of the current or most recent spoken user or assistant text. It
  belongs to that call, including native speech and realtime Talk, not another
  selected chat. Captions remain visible with speaker audio off. No empty
  transcript box is reserved; full history stays in Chat. Speaker labels and
  utterances align to the left within a theme-aware caption surface. **Details**
  opens a read-only mobile sheet without ending the call or stopping agent work.
- **Photo** captures a still image using the selected **Selfie** or **Rear**
  camera. Inspect its preview, then use **Send photos** directly on the conversation
  page. This sends only the displayed photos to the call's original chat; unsent
  text and other attachments stay in the composer. **Go to chat** remains available
  when you want to add a message. Capture never sends automatically and remains
  foreground-only and permission-gated.
- Reading, writing/editing, searching, tool work, approvals, and input waits use
  Gateway events for the call's original conversation, including work not started
  by the current voice request. They do not follow another selected chat. Missing
  or interrupted observation is recorded as incomplete rather than guessed as idle;
  its technical explanation appears under **Details**, not beside the avatar.
  Observation alone does not create another spoken reply or chat turn.
- Dictation, voice-note recording, and Talk are mutually exclusive microphone
  paths; starting one stops or blocks the others.
- Realtime Talk prefers a connected Bluetooth Classic or BLE headset
  microphone; if it disconnects, the app requests another headset input or
  falls back to the default microphone, restoring the default preference once
  capture stops.
- Realtime Talk requests Android communication mode and audio focus, using a
  connected external output or the built-in speaker. Microphone audio is sent
  during playback only while acoustic echo cancellation is enabled and the
  communication mode and focus remain active. Without echo cancellation,
  microphone audio is not sent during playback. Android presentation timestamps
  estimate playback completion when available. Routes without usable timestamps use
  approximate playback position plus the nominal PCM duration; this cannot
  guarantee that all acoustic output has drained on every device.
- Losing audio focus or encountering a playback-device failure ends realtime
  Talk with an error. Interruption clears queued output before capture resumes;
  stopped sessions cannot acknowledge playback through a replacement Gateway.
- Realtime **Thinking** follows provider response generation, an accepted
  OpenClaw consult, or matching original-conversation work—not input transcription,
  which may finish after the answer.
  Direct replies without a provider or Gateway response-start signal stay
  **Listening** until output arrives. Empty completed responses return to **Listening**;
  buffered audio stays **Speaking** until playback drains.
- Dictation and voice-note recording stop when the app leaves the foreground or
  the user leaves Chat.
- An admitted, foreground-started Chat call retains Android's microphone
  foreground service when navigating away, switching apps, or locking the screen.
  Pending startup, generic Talk, and push-to-talk do not acquire that exception.
  Connection or microphone-permission loss ends the call; reconnecting does not
  restart it. Physical-device background/lock-screen verification is still
  required, and this is not a guarantee for every manufacturer's power policy.
- Android supports `pcm_16000`, `pcm_22050`, `pcm_24000`, and `pcm_44100` output formats for low-latency `AudioTrack` streaming.

package ai.openclaw.app.voice

import ai.openclaw.app.chat.ChatToolKind
import ai.openclaw.app.chat.chatToolKind
import ai.openclaw.app.resolveAgentIdFromMainSessionKey
import android.util.Log
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal data class RealtimeAgentSession(
  val relaySessionId: String?,
  val sessionKey: String,
)

internal enum class TalkAgentActivity {
  Thinking,
  Reading,
  Writing,
  Searching,
  ToolWork,
  WaitingForApproval,
  WaitingForInput,
  Error,
  Waiting,
  Unknown,
}

internal data class RealtimeAgentActivity(
  val session: RealtimeAgentSession,
  val activity: TalkAgentActivity,
  val observationOwner: TalkModeManager.ChatStart? = null,
  val incomplete: Boolean = false,
)

private sealed interface RealtimeRunCompletion {
  val session: RealtimeAgentSession

  data class Relay(
    override val session: RealtimeAgentSession,
    val callId: String,
  ) : RealtimeRunCompletion

  data class NativeInput(
    override val session: RealtimeAgentSession,
  ) : RealtimeRunCompletion
}

private class RealtimeAgentRun(
  val runId: String,
  var agentSessionKey: String,
  var agentId: String?,
  var completion: RealtimeRunCompletion? = null,
  var observationOwner: TalkModeManager.ChatStart? = null,
) {
  var targetUnspecified = false
  var sequence = -1L
  var finished = false
  var failed = false
  var waiting = false
  var incomplete = false
  val tools = linkedMapOf<String, TalkAgentActivity>()
  val approvals = linkedMapOf<String, Set<String>>()
  val questions = mutableSetOf<String>()

  fun activity(): TalkAgentActivity? =
    when {
      failed -> TalkAgentActivity.Error

      // A run-liveness snapshot does not resolve approvals, questions, or yielded waits.
      approvals.isNotEmpty() -> TalkAgentActivity.WaitingForApproval

      questions.isNotEmpty() -> TalkAgentActivity.WaitingForInput

      waiting -> TalkAgentActivity.Waiting

      finished -> null

      tools.isNotEmpty() -> tools.values.last()

      incomplete -> TalkAgentActivity.Unknown

      else -> TalkAgentActivity.Thinking
    }
}

private class RealtimeConversationObservation(
  val owner: TalkModeManager.ChatStart,
  var key: String? = null,
  var incomplete: Boolean = true,
  var obligationsIncomplete: Boolean = false,
  var revision: Long = 0,
) {
  val presentationSession = RealtimeAgentSession(null, owner.owner.sessionKey)
}

private data class RealtimeQuestionObservation(
  val id: String,
  val runId: String?,
  val sessionKey: String?,
  val agentId: String?,
  val expiresAtMs: Long,
)

private data class RealtimeAgentActivityEvent(
  val runId: String,
  val sessionKey: String,
  val agentId: String?,
  val sequence: Long,
  val stream: String,
  val phase: String?,
  val name: String?,
  val toolCallId: String?,
  val approvalId: String?,
  val isError: Boolean,
  val status: String?,
  val itemId: String?,
  val yieldedWaiting: Boolean,
  val pending: Set<RealtimeAgentPendingCall>,
) {
  // Set only after applying this event or recording its loss; a later sequence is not proof.
  var accountedFor = false
}

private data class RealtimeAgentCompletion(
  val sessionKey: String?,
  val state: String,
  val message: JsonElement?,
  val agentId: String? = null,
  val pendingCalls: Set<RealtimeAgentPendingCall> = emptySet(),
)

internal data class RealtimeAgentUnhandledCompletion(
  val sessionKey: String?,
  val runId: String,
  val state: String,
  val message: JsonElement?,
)

internal class RealtimeAgentPendingCall(
  val callId: String?,
  val session: RealtimeAgentSession,
  val externalAckOnly: Boolean = false,
) {
  var job: Job? = null
  var failed = false
}

private data class RealtimeAgentCacheOverflow(
  val unhandled: List<RealtimeAgentUnhandledCompletion>,
  val failedCalls: List<RealtimeAgentPendingCall>,
)

private data class RealtimeAgentPendingFinish(
  val canSubmitError: Boolean,
  val unhandled: List<RealtimeAgentUnhandledCompletion>,
)

private data class RealtimeAgentRunRegistration(
  val completion: RealtimeAgentCompletion?,
  val errorMessage: String?,
  val unhandled: List<RealtimeAgentUnhandledCompletion>,
)

/**
 * Owns Android's call/run correlation and realtime provider-tool completion.
 * Replacing the session cancels session-owned work while retaining bounded
 * correlation for late Gateway responses; transport replacement cancels both.
 */
internal class RealtimeAgentCoordinator(
  parentScope: CoroutineScope,
  private val requestGateway: suspend (method: String, paramsJson: String?, timeoutMs: Long) -> String,
  private val onWorking: (RealtimeAgentSession) -> Unit = {},
  private val onError: (RealtimeAgentSession, String) -> Unit = { _, message ->
    Log.w(TAG, message)
  },
  private val onUnhandledCompletion: (RealtimeAgentUnhandledCompletion) -> Unit = {},
  private val maxCachedCompletions: Int = MAX_CACHED_COMPLETIONS,
) {
  private val json = Json { ignoreUnknownKeys = true }
  private val lock = Any()
  private val parentContext = parentScope.coroutineContext
  private val parentJob = parentContext[Job]
  private var transportGeneration = Any()
  private var activeSession: RealtimeAgentSession? = null
  private var sessionScope: CoroutineScope? = null
  private val correlationJobs = LinkedHashSet<Job>()
  private val runs = LinkedHashMap<String, RealtimeAgentRun>()
  private val earlyAgentEvents = ArrayDeque<RealtimeAgentActivityEvent>()
  private val questions = linkedMapOf<String, RealtimeQuestionObservation>()
  private val resolvedQuestionIds = linkedSetOf<String>()
  private var observation: RealtimeConversationObservation? = null
  private var questionExpiryJob: Job? = null
  private var questionExpiryAt: Long? = null
  private var questionExpiryToken: Any? = null
  private val _activity = MutableStateFlow<RealtimeAgentActivity?>(null)
  val activity: StateFlow<RealtimeAgentActivity?> = _activity
  private val pendingCalls = LinkedHashSet<RealtimeAgentPendingCall>()
  private val earlyCompletions = LinkedHashMap<Pair<String, String?>, RealtimeAgentCompletion>()

  // A replacement can reuse the same chat session key, so keep known old run IDs
  // long enough to consume delayed finals instead of leaking them into normal Talk TTS.
  private val retiredRunIds = LinkedHashSet<String>()

  init {
    require(maxCachedCompletions > 0)
  }

  fun beginSession(
    session: RealtimeAgentSession,
    observationOwner: TalkModeManager.ChatStart? = null,
  ) {
    val unhandled =
      synchronized(lock) {
        if (activeSession === session) return
        clearSessionLocked(preserveObservation = observationOwner != null && observation?.owner === observationOwner).also {
          activeSession = session
          sessionScope = CoroutineScope(parentContext + SupervisorJob(parentJob))
          publishActivityLocked()
        }
      }
    unhandled.forEach(onUnhandledCompletion)
  }

  fun endSession(
    expectedRelaySessionId: String? = null,
    observationOwner: TalkModeManager.ChatStart? = null,
  ) {
    val unhandled =
      synchronized(lock) {
        if (expectedRelaySessionId != null && activeSession?.relaySessionId != expectedRelaySessionId) return
        clearSessionLocked(preserveObservation = observationOwner != null && observation?.owner === observationOwner)
      }
    unhandled.forEach(onUnhandledCompletion)
  }

  /** Cancels requests that must not survive a Gateway or account replacement. */
  fun resetTransport() {
    // Lazy correlation jobs can complete synchronously during cancellation. Drop
    // account-bound state first so their handlers cannot release stale output.
    val staleJobs =
      synchronized(lock) {
        clearSessionLocked()
        transportGeneration = Any()
        val jobs = correlationJobs.toList()
        correlationJobs.clear()
        pendingCalls.clear()
        earlyCompletions.clear()
        jobs
      }
    staleJobs.forEach(Job::cancel)
  }

  fun handleToolCall(
    callId: String,
    name: String,
    args: JsonElement?,
    forced: Boolean,
  ): Boolean {
    val sessionAndScopes =
      synchronized(lock) {
        val session = activeSession ?: return false
        if (session.relaySessionId == null) return false
        val resultScope = sessionScope ?: return false
        Triple(session, resultScope, transportGeneration)
      }
    val (session, resultScope, generation) = sessionAndScopes
    when (name) {
      AGENT_CONSULT_TOOL -> {
        val pendingCall = RealtimeAgentPendingCall(callId = callId, session = session)
        val accepted =
          synchronized(lock) {
            activeSession === session &&
              makeRunSpaceLocked(forCompletion = true) &&
              pendingCalls.add(pendingCall)
          }
        if (accepted) {
          val supervisor = SupervisorJob(parentJob)
          val job =
            CoroutineScope(parentContext + supervisor).launch(start = CoroutineStart.LAZY) {
              runConsult(pendingCall, args, forced)
            }
          job.invokeOnCompletion {
            supervisor.cancel()
            synchronized(lock) { correlationJobs.remove(job) }
            finishPending(pendingCall).unhandled.forEach(onUnhandledCompletion)
          }
          val shouldStart =
            synchronized(lock) {
              if (
                activeSession === session &&
                transportGeneration === generation &&
                isPendingLocked(pendingCall)
              ) {
                pendingCall.job = job
                correlationJobs += job
                true
              } else {
                false
              }
            }
          if (shouldStart) job.start() else job.cancel()
        } else {
          resultScope.launch { submitError(session, callId, "too many concurrent realtime Talk tool calls") }
        }
      }

      AGENT_CONTROL_TOOL -> {
        resultScope.launch { runControl(session, callId, args) }
      }

      else -> {
        resultScope.launch { submitError(session, callId, "unsupported realtime Talk tool: $name") }
      }
    }
    return true
  }

  fun handleChatEvent(
    sessionKey: String?,
    runId: String,
    state: String,
    message: JsonElement?,
    agentId: String? = null,
    sequence: Long? = null,
    yielded: Boolean = false,
    externalCompletionOwner: Boolean = false,
  ): Boolean {
    if (state !in TERMINAL_STATES) return false
    val completion = RealtimeAgentCompletion(sessionKey = sessionKey, state = state, message = message, agentId = agentId)
    var dispatch: Pair<RealtimeRunCompletion.Relay, RealtimeAgentCompletion>? = null
    var overflow: RealtimeAgentCacheOverflow? = null
    val handled =
      synchronized(lock) {
        val observed = observation?.takeIf { matchesObservation(it, sessionKey, agentId) }
        val run = observed?.let { admitObservedRunLocked(it, runId, sessionKey ?: return@synchronized false, agentId) } ?: runs[runId]
        run?.let(::associateObservationLocked)
        if (observed != null && yielded && (run == null || run.agentSessionKey != sessionKey)) {
          observed.incomplete = true
          observed.obligationsIncomplete = true
          observed.revision++
          publishActivityLocked()
        }
        val expectedAgent =
          run?.agentId
            ?: (run?.agentSessionKey ?: sessionKey)?.takeIf { it.startsWith("agent:") }?.let { resolveAgentIdFromMainSessionKey(it) }
            ?: observation
              ?.takeIf { it.key != null && it.key == sessionKey }
              ?.owner
              ?.owner
              ?.agentId
        if (agentId != null && expectedAgent != null && agentId != expectedAgent) return@synchronized true
        val binding = run?.completion
        if (run != null && (agentId == null || run.agentId == null || agentId == run.agentId) &&
          (
            (binding != null && (sessionKey == null || sessionKey == run.agentSessionKey)) ||
              (observed != null && run.agentSessionKey == sessionKey)
          )
        ) {
          if (sequence == null || sequence >= run.sequence) {
            observed?.let { it.revision++ }
            run.sequence = maxOf(run.sequence, sequence ?: run.sequence)
            run.finished = !yielded
            run.waiting = yielded
            run.failed = state == "error"
            run.tools.clear()
            if (!yielded) run.approvals.clear()
          }
          when (binding) {
            is RealtimeRunCompletion.Relay -> {
              run.completion = null
              retireRunLocked(runId)
              if (binding.session === activeSession) dispatch = binding to completion
              if (run.observationOwner == null) runs.remove(runId)
              publishActivityLocked()
              true
            }

            is RealtimeRunCompletion.NativeInput -> {
              run.completion = null
              retireRunLocked(runId)
              if (run.observationOwner == null) runs.remove(runId)
              publishActivityLocked()
              false
            }

            null -> {
              publishActivityLocked()
              if (runId in retiredRunIds) {
                true
              } else if (externalCompletionOwner) {
                false
              } else if (pendingCalls.any { !it.failed }) {
                overflow = cacheEarlyCompletionLocked(runId, completion)
                true
              } else {
                true
              }
            }
          }
        } else if (runId in retiredRunIds) {
          true
        } else if (externalCompletionOwner) {
          false
        } else if (pendingCalls.any { !it.failed }) {
          overflow = cacheEarlyCompletionLocked(runId, completion)
          true
        } else {
          false
        }
      }
    dispatch?.let { dispatchCompletion(it.first, it.second) }
    overflow?.let { result ->
      result.unhandled.forEach(onUnhandledCompletion)
      failOverflowedCalls(result.failedCalls)
    }
    return handled
  }

  /** Native speech uses the same ACK correlation, without a provider tool-result writer. */
  fun beginChatSend(): RealtimeAgentPendingCall? =
    synchronized(lock) {
      val session = activeSession?.takeIf { it.relaySessionId == null } ?: return null
      if (!makeRunSpaceLocked(forCompletion = true)) return null
      RealtimeAgentPendingCall(null, session).also { pendingCalls.add(it) }
    }

  /** One serialized generic/PTT sender owns its final outside the relay session.
   * This ACK marker is independent of observation capacity and adds no result writer.
   */
  fun beginExternalChatSend(sessionKey: String): RealtimeAgentPendingCall =
    synchronized(lock) {
      check(pendingCalls.none { it.externalAckOnly }) { "Another Talk input is awaiting its acknowledgement" }
      RealtimeAgentPendingCall(null, RealtimeAgentSession(null, sessionKey), externalAckOnly = true).also { pendingCalls.add(it) }
    }

  fun finishChatSend(
    pending: RealtimeAgentPendingCall?,
    runId: String?,
    agentId: String?,
    terminal: Boolean = false,
  ) {
    if (pending == null) return
    val unhandled =
      synchronized(lock) {
        if (!pendingCalls.remove(pending)) return
        if (pending.externalAckOnly) {
          if (runId != null) check(!pending.failed) { "Talk completion correlation buffer overflow" }
          val cached =
            runId?.takeIf { it !in retiredRunIds }?.let { id ->
              eligibleEarlyCompletionLocked(id, pending.session.sessionKey, null, pending)
            }
          val owned =
            if (cached == null) {
              emptyList()
            } else {
              val id = checkNotNull(runId)
              earlyCompletions.remove(id to cached.sessionKey)
              earlyCompletions.remove(id to null)
              listOf(cached.toUnhandled(id))
            }
          pruneEarlyActivityLocked()
          return@synchronized owned + drainUnclaimedCompletionsLocked()
        }
        if (runId != null && !pending.failed && pending.session === activeSession && runId !in retiredRunIds && runs[runId]?.completion == null) {
          val completed = eligibleEarlyCompletionLocked(runId, pending.session.sessionKey, agentId, pending) != null
          if (!terminal && !completed) {
            val run = runs[runId] ?: RealtimeAgentRun(runId, pending.session.sessionKey, agentId)
            run.completion = RealtimeRunCompletion.NativeInput(pending.session)
            runs[runId] = run
            earlyAgentEvents.filter { it.runId == runId && pending in it.pending }.forEach { applyActivityLocked(run, it) }
            questions.values.forEach { record -> attachQuestionLocked(run, record) }
          }
        }
        pruneEarlyActivityLocked()
        publishActivityLocked()
        drainUnclaimedCompletionsLocked()
      }
    // Native Talk's existing pending-final owner consumes these; no relay result or new chat turn.
    unhandled.forEach(onUnhandledCompletion)
  }

  fun endChatRun(runId: String?) {
    if (runId == null) return
    synchronized(lock) {
      val run = runs[runId] ?: return
      if (run.completion !is RealtimeRunCompletion.NativeInput) return
      associateObservationLocked(run)
      run.completion = null
      if (run.observationOwner == null) runs.remove(runId)
      retireRunLocked(runId)
      publishActivityLocked()
    }
  }

  fun beginConversationObservation(owner: TalkModeManager.ChatStart) {
    synchronized(lock) {
      if (observation?.owner === owner) return
      observation = RealtimeConversationObservation(owner)
      runs.entries.removeAll { it.value.completion == null }
      earlyAgentEvents.clear()
      questions.clear()
      resolvedQuestionIds.clear()
      scheduleQuestionExpiryLocked()
      publishActivityLocked()
    }
  }

  fun confirmConversationObservation(
    owner: TalkModeManager.ChatStart,
    key: String,
  ): Boolean =
    synchronized(lock) {
      val current = observation?.takeIf { it.owner === owner && owner.canStart() } ?: return false
      if (key.isBlank() || resolveAgentIdFromMainSessionKey(key)?.let { it != owner.owner.agentId } == true) return false
      current.key = key
      val buffered = earlyAgentEvents.toList()
      buffered.forEach { event ->
        if (matchesObservation(current, event.sessionKey, event.agentId)) {
          admitObservedRunLocked(current, event.runId, event.sessionKey, event.agentId)?.let { applyActivityLocked(it, event) }
        }
      }
      pruneEarlyActivityLocked { true }
      questions.entries.removeAll { !matchesObservation(current, it.value.sessionKey, it.value.agentId) }
      questions.values.forEach { record ->
        record.runId?.let { runId -> admitObservedRunLocked(current, runId, key, owner.owner.agentId) }?.let { attachQuestionLocked(it, record) }
      }
      scheduleQuestionExpiryLocked()
      publishActivityLocked()
      true
    }

  fun retireConversationObservation(owner: TalkModeManager.ChatStart) {
    synchronized(lock) {
      if (observation?.owner !== owner) return
      observation = null
      runs.entries.removeAll { it.value.completion == null }
      earlyAgentEvents.clear()
      questions.clear()
      resolvedQuestionIds.clear()
      scheduleQuestionExpiryLocked()
      publishActivityLocked()
    }
  }

  fun observationRevision(owner: TalkModeManager.ChatStart): Long? =
    synchronized(lock) {
      observation?.takeIf { it.owner === owner && owner.lease.isCurrent() }?.revision
    }

  fun markObservationIncomplete(
    owner: TalkModeManager.ChatStart,
    clearTransient: Boolean = false,
  ) {
    synchronized(lock) {
      val current = observation?.takeIf { it.owner === owner } ?: return
      current.incomplete = true
      current.revision++
      if (clearTransient) {
        runs.values.filter { it.observationOwner === owner }.forEach {
          it.incomplete = true
          // Tool progress may have been lost. Pending obligations need their own
          // resolution or expiry; a run snapshot cannot clear them.
          it.tools.clear()
        }
      }
      scheduleQuestionExpiryLocked()
      publishActivityLocked()
    }
  }

  /** An explicit, matching snapshot can establish join/recovery state; silence cannot. */
  fun applyConversationSnapshot(
    owner: TalkModeManager.ChatStart,
    revision: Long,
    payload: JsonObject,
  ) {
    synchronized(lock) {
      val current = observation?.takeIf { it.owner === owner && it.revision == revision } ?: return
      val entry = payload["sessionInfo"] as? JsonObject ?: return
      val key = entry["key"].asStringOrNull() ?: return
      val agent = entry["agentId"].asStringOrNull()
      if (!matchesObservation(current, key, agent)) return
      val active =
        (entry["hasActiveRun"] as? JsonPrimitive)?.content?.let {
          if (it == "true") {
            true
          } else if (it == "false") {
            false
          } else {
            null
          }
        } ?: return
      val rawIds = entry["activeRunIds"]
      val ids =
        when (rawIds) {
          null, JsonNull -> null
          is JsonArray -> rawIds.map { it.asIdOrNull() ?: return }
          else -> return
        }
      if (ids != null && (ids.size > maxCachedCompletions || (!active && ids.isNotEmpty()))) return
      current.incomplete = active || current.obligationsIncomplete
      if (ids != null) {
        // A supplied array is the complete active set; omission is not an empty set.
        // Pending obligations retain their own resolution/expiry, independent of liveness.
        runs.values.filter { it.observationOwner === owner && it.completion == null && it.runId !in ids }.forEach {
          it.finished = true
          it.failed = false
          it.tools.clear()
        }
        ids.forEach { runId ->
          if (runId !in runs) admitObservedRunLocked(current, runId, key, owner.owner.agentId)?.incomplete = true
        }
      }
      publishActivityLocked()
    }
  }

  /** Consume both agent and session.tool at their canonical ingress, before selected-chat filtering. */
  fun handleAgentEvent(payload: JsonObject) {
    val data = payload["data"] as? JsonObject ?: return
    synchronized(lock) {
      val runId = payload["runId"].asIdOrNull() ?: return
      val key = payload["sessionKey"].asIdOrNull() ?: return
      val agent = payload["agentId"].asIdOrNull()
      val current = observation
      if (current != null && !matchesObservationAgent(current, key, agent)) return
      if (current?.key != null && !matchesObservation(current, key, agent)) return
      val event =
        RealtimeAgentActivityEvent(
          runId = runId,
          sessionKey = key,
          agentId = agent,
          sequence = (payload["seq"] as? JsonPrimitive)?.content?.toLongOrNull()?.takeIf { it >= 0 } ?: return,
          stream = payload["stream"].asIdOrNull() ?: return,
          phase = data["phase"].asIdOrNull(),
          name = data["name"].asIdOrNull(),
          toolCallId = data["toolCallId"].asIdOrNull(),
          approvalId = data["approvalId"].asIdOrNull(),
          isError = (data["isError"] as? JsonPrimitive)?.content == "true",
          status = data["status"].asIdOrNull(),
          itemId = data["itemId"].asIdOrNull(),
          yieldedWaiting =
            data["phase"].asStringOrNull() == "end" &&
              (data["yielded"] as? JsonPrimitive)?.content == "true" && data["livenessState"].asStringOrNull() == "paused" &&
              data["stopReason"].asStringOrNull() == "end_turn" && (data["aborted"] as? JsonPrimitive)?.content != "true" &&
              data["status"].asStringOrNull() !in setOf("cancelled", "timed_out") &&
              (data["timeoutPhase"] == null || data["timeoutPhase"] == JsonNull) && (data["error"] == null || data["error"] == JsonNull),
          pending = pendingCalls.filterNot { it.failed }.toSet(),
        )
      val run = current?.takeIf { matchesObservation(it, key, agent) }?.let { admitObservedRunLocked(it, runId, key, agent) } ?: runs[runId]
      if (run != null) {
        associateObservationLocked(run)
        applyActivityLocked(run, event)
        publishActivityLocked()
      } else if (event.pending.isNotEmpty() || (current?.key == null && current != null)) {
        if (earlyAgentEvents.size == maxCachedCompletions) {
          val oldest = earlyAgentEvents.first()
          pruneEarlyActivityLocked { it === oldest }
        }
        earlyAgentEvents.addLast(event)
      } else {
        markDroppedActivityLocked(event)
      }
    }
  }

  // ACK, timeout, confirmation and eviction consume the same recorded facts.
  // Only retiring the whole observation may discard its obligations outright.
  private fun pruneEarlyActivityLocked(
    discard: (RealtimeAgentActivityEvent) -> Boolean = { event ->
      event.pending.none(::isPendingLocked) && (observation == null || observation?.key != null)
    },
  ) {
    earlyAgentEvents.removeAll { event ->
      discard(event).also { removed ->
        if (removed && !event.accountedFor) markDroppedActivityLocked(event)
      }
    }
  }

  private fun markDroppedActivityLocked(event: RealtimeAgentActivityEvent) {
    val current =
      observation?.takeIf {
        matchesObservationAgent(it, event.sessionKey, event.agentId) &&
          (it.key == null || it.key == event.sessionKey)
      } ?: return
    current.incomplete = true
    current.revision++
    if ((event.stream == "lifecycle" && (event.phase == "waiting-approval" || event.yieldedWaiting)) ||
      (event.stream == "approval" && event.phase == "requested" && event.status == "pending")
    ) {
      current.obligationsIncomplete = true
    }
    event.accountedFor = true
    publishActivityLocked()
  }

  private fun associateObservationLocked(run: RealtimeAgentRun) {
    observation?.takeIf { matchesObservation(it, run.agentSessionKey, run.agentId) }?.let {
      run.observationOwner = it.owner
    }
  }

  private fun matchesObservationAgent(
    current: RealtimeConversationObservation,
    key: String?,
    agentId: String?,
  ): Boolean = current.owner.lease.isCurrent() && (agentId ?: resolveAgentIdFromMainSessionKey(key)) == current.owner.owner.agentId

  private fun matchesObservation(
    current: RealtimeConversationObservation,
    key: String?,
    agentId: String?,
  ): Boolean = current.key != null && key == current.key && matchesObservationAgent(current, key, agentId)

  // Observations must not consume completion capacity. Reserve a slot before ACK,
  // dropping only observer records; incomplete activity never drops a result writer.
  private fun makeRunSpaceLocked(forCompletion: Boolean): Boolean {
    while (pendingCalls.size + runs.size >= maxCachedCompletions) {
      val disposable =
        runs.values.firstOrNull { it.completion == null && it.finished }
          ?: runs.values.firstOrNull { forCompletion && it.completion == null }
          ?: return false
      runs.remove(disposable.runId)
      if (disposable.approvals.isNotEmpty() || disposable.waiting) observation?.obligationsIncomplete = true
      if (!disposable.finished || disposable.approvals.isNotEmpty() || disposable.questions.isNotEmpty() || disposable.waiting) observation?.incomplete = true
      publishActivityLocked()
    }
    return true
  }

  private fun admitObservedRunLocked(
    current: RealtimeConversationObservation,
    runId: String,
    key: String,
    agentId: String?,
  ): RealtimeAgentRun? {
    if (runId.length > MAX_ACTIVITY_ID_CHARS || !matchesObservation(current, key, agentId)) return null
    val existing = runs[runId]
    if (existing != null) {
      val binding = existing.completion
      if (existing.targetUnspecified && binding is RealtimeRunCompletion.Relay && binding.session === activeSession &&
        (existing.agentId == null || existing.agentId == current.owner.owner.agentId)
      ) {
        existing.agentSessionKey = key
        existing.agentId = current.owner.owner.agentId
        existing.targetUnspecified = false
      }
      if (existing.agentSessionKey != key || (existing.agentId != null && existing.agentId != current.owner.owner.agentId)) return null
      if (existing.agentId == null) existing.agentId = current.owner.owner.agentId
      existing.observationOwner = current.owner
      questions.values.forEach { attachQuestionLocked(existing, it) }
      return existing
    }
    if (!makeRunSpaceLocked(forCompletion = false)) {
      current.incomplete = true
      return null
    }
    return RealtimeAgentRun(runId, key, current.owner.owner.agentId, observationOwner = current.owner).also { run ->
      runs[runId] = run
      questions.values.forEach { attachQuestionLocked(run, it) }
    }
  }

  private fun applyActivityLocked(
    run: RealtimeAgentRun,
    event: RealtimeAgentActivityEvent,
  ) {
    val current = observation
    val observed = current != null && run.observationOwner === current.owner && matchesObservation(current, event.sessionKey, event.agentId)
    if (!observed && (run.completion == null || run.completion?.session !== activeSession)) return
    if (event.runId != run.runId || event.sessionKey != run.agentSessionKey || event.sequence <= run.sequence) return
    if (run.agentId != null && event.agentId != null && run.agentId != event.agentId) return
    if (!run.agentSessionKey.startsWith("agent:") && (run.agentId == null || event.agentId != run.agentId)) return
    run.sequence = event.sequence
    if (observed) current.revision++
    val startsWork = event.stream in setOf("thinking", "assistant") || (event.stream == "tool" && event.phase in setOf("start", "input_delta")) || (event.stream == "lifecycle" && event.phase in setOf("start", "retrying"))
    if (startsWork) {
      // A completed error remains useful until newer work starts, not forever.
      runs.values.filter { it !== run && it.finished }.forEach { it.failed = false }
      run.finished = false
      run.failed = false
      run.waiting = false
    }
    when (event.stream) {
      "lifecycle" -> {
        when (event.phase) {
          "waiting-approval" -> {
            applyApprovalLocked(run, event, pending = true)
          }

          "approval-resolved" -> {
            applyApprovalLocked(run, event, pending = false)
          }

          "end" -> {
            run.finished = !event.yieldedWaiting
            run.waiting = event.yieldedWaiting
            run.tools.clear()
            if (run.finished) run.approvals.clear()
          }

          "error" -> {
            run.failed = true
            run.finished = false
            run.tools.clear()
          }
        }
      }

      "approval" -> {
        applyApprovalLocked(run, event, pending = event.phase == "requested" && event.status == "pending")
        if (event.status in setOf("unavailable", "failed", "denied")) run.failed = true
      }

      "tool" -> {
        val id = event.toolCallId ?: return
        when (event.phase) {
          "start", "input_delta" -> {
            if (id !in run.tools && run.tools.size >= MAX_RUN_ACTIVITY_ITEMS) {
              run.incomplete = true
              return
            }
            run.tools[id] =
              when (chatToolKind(event.name.orEmpty())) {
                ChatToolKind.Read -> TalkAgentActivity.Reading
                ChatToolKind.Edit, ChatToolKind.Write -> TalkAgentActivity.Writing
                ChatToolKind.Search, ChatToolKind.Fetch -> TalkAgentActivity.Searching
                else -> TalkAgentActivity.ToolWork
              }
          }

          "result" -> {
            run.tools.remove(id)
            run.failed = event.isError
          }
        }
      }

      "error" -> {
        run.failed = true
      }
    }
    event.accountedFor = true
  }

  private fun applyApprovalLocked(
    run: RealtimeAgentRun,
    event: RealtimeAgentActivityEvent,
    pending: Boolean,
  ) {
    val ids = setOfNotNull(event.approvalId?.let { "approval:$it" }, event.toolCallId?.let { "tool:$it" }, event.itemId?.let { "item:$it" })
    if (ids.isEmpty()) {
      run.incomplete = true
      if (pending) markDroppedActivityLocked(event)
      return
    }
    val matches = run.approvals.filterValues { known -> known.any { it in ids } }
    val merged = ids + matches.values.flatten()
    matches.keys.forEach(run.approvals::remove)
    if (pending) {
      if (run.approvals.size >= MAX_RUN_ACTIVITY_ITEMS) {
        run.incomplete = true
        markDroppedActivityLocked(event)
        return
      }
      run.approvals[merged.sorted().first()] = merged
    }
  }

  /** Keep question identity/expiry only; answers and question text never enter the activity cache. */
  fun handleQuestionEvent(
    event: String,
    payload: JsonObject,
  ) {
    synchronized(lock) {
      val id = payload["id"].asIdOrNull() ?: return
      if (event == "question.resolved") {
        resolvedQuestionIds.add(id)
        while (resolvedQuestionIds.size > maxCachedCompletions) resolvedQuestionIds.remove(resolvedQuestionIds.first())
        questions.remove(id)
        runs.values.forEach { it.questions.remove(id) }
        scheduleQuestionExpiryLocked()
        publishActivityLocked()
        return
      }
      if (id in resolvedQuestionIds || payload["status"].asStringOrNull() != "pending") return
      val record = RealtimeQuestionObservation(id, payload["runId"].asIdOrNull(), payload["sessionKey"].asIdOrNull(), payload["agentId"].asIdOrNull(), (payload["expiresAtMs"] as? JsonPrimitive)?.content?.toLongOrNull() ?: return)
      if (record.expiresAtMs <= System.currentTimeMillis()) return
      val current = observation
      if (current != null && !matchesObservationAgent(current, record.sessionKey, record.agentId)) return
      if (current?.key != null && !matchesObservation(current, record.sessionKey, record.agentId)) return
      val run =
        record.runId?.let { id ->
          current
            ?.takeIf { matchesObservation(it, record.sessionKey, record.agentId) }
            ?.let { admitObservedRunLocked(it, id, record.sessionKey ?: return, record.agentId) }
            ?: runs[id]
        }
      if (run == null && pendingCalls.none { !it.failed } && current == null) return
      if (id !in questions && questions.size >= maxCachedCompletions) {
        current?.let {
          it.incomplete = true
          it.obligationsIncomplete = true
          it.revision++
        }
        publishActivityLocked()
        return
      }
      if (questions[id] == record) return
      questions[id] = record
      if (run != null) {
        associateObservationLocked(run)
        attachQuestionLocked(run, record)
      }
      if (current != null) current.revision++
      scheduleQuestionExpiryLocked()
      publishActivityLocked()
    }
  }

  private fun attachQuestionLocked(
    run: RealtimeAgentRun,
    record: RealtimeQuestionObservation,
  ) {
    if (record.runId == null || record.runId != run.runId || record.sessionKey != run.agentSessionKey) return
    val expectedAgent = run.agentId ?: resolveAgentIdFromMainSessionKey(run.agentSessionKey)
    val questionAgent = record.agentId ?: resolveAgentIdFromMainSessionKey(record.sessionKey)
    if (expectedAgent == null || questionAgent != expectedAgent) return
    if (run.questions.size >= MAX_RUN_ACTIVITY_ITEMS && record.id !in run.questions) {
      run.incomplete = true
      return
    }
    if (record.expiresAtMs > System.currentTimeMillis()) run.questions.add(record.id)
  }

  private fun scheduleQuestionExpiryLocked() {
    val next = questions.values.minOfOrNull { it.expiresAtMs }
    if (next == questionExpiryAt && questionExpiryJob?.isActive == true) return
    questionExpiryJob?.cancel()
    questionExpiryJob = null
    questionExpiryAt = next
    val token = Any()
    questionExpiryToken = token
    if (next == null) return
    questionExpiryJob =
      CoroutineScope(parentContext).launch {
        delay((next - System.currentTimeMillis()).coerceAtLeast(0))
        synchronized(lock) {
          if (questionExpiryToken !== token) return@synchronized
          val expired =
            questions.values
              .filter { it.expiresAtMs <= System.currentTimeMillis() }
              .map { it.id }
              .toSet()
          expired.forEach(questions::remove)
          runs.values.forEach { it.questions.removeAll(expired) }
          questionExpiryAt = null
          scheduleQuestionExpiryLocked()
          publishActivityLocked()
        }
      }
  }

  private fun publishActivityLocked() {
    val current = observation?.takeIf { it.owner.lease.isCurrent() }
    val session = activeSession ?: current?.presentationSession
    val activities = runs.values.filter { (it.completion?.session === activeSession && it.completion != null) || (current != null && it.observationOwner === current.owner) }.mapNotNull { it.activity() }
    val unboundQuestion = current != null && questions.values.any { (it.runId == null || runs[it.runId]?.questions?.contains(it.id) != true) && matchesObservation(current, it.sessionKey, it.agentId) }
    val activity =
      if (unboundQuestion) {
        TalkAgentActivity.WaitingForInput
      } else {
        activities.firstOrNull { it == TalkAgentActivity.WaitingForApproval || it == TalkAgentActivity.WaitingForInput }
          ?: activities.firstOrNull { it != TalkAgentActivity.Thinking }
          ?: activities.firstOrNull()
          ?: TalkAgentActivity.Unknown.takeIf { current?.incomplete == true }
      }
    _activity.value = if (session != null && activity != null) RealtimeAgentActivity(session, activity, current?.owner, current?.incomplete == true) else null
  }

  private suspend fun runConsult(
    pendingCall: RealtimeAgentPendingCall,
    args: JsonElement?,
    forced: Boolean,
  ) {
    val session = pendingCall.session
    val callId = checkNotNull(pendingCall.callId)
    try {
      if (forced) submitWorking(session, callId)
      if (!isActive(session)) return
      val params =
        buildJsonObject {
          put("sessionKey", JsonPrimitive(session.sessionKey))
          put("callId", JsonPrimitive(callId))
          put("name", JsonPrimitive(AGENT_CONSULT_TOOL))
          put("relaySessionId", JsonPrimitive(session.relaySessionId))
          if (args != null) put("args", args)
        }
      val response = requestGateway("talk.client.toolCall", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
      val ack = runCatching { json.parseToJsonElement(response) as? JsonObject }.getOrNull()
      val runId = ack?.get("runId").asStringOrNull()
      if (runId.isNullOrBlank()) {
        val finish = finishPending(pendingCall)
        finish.unhandled.forEach(onUnhandledCompletion)
        if (finish.canSubmitError) submitError(session, callId, "tool call returned no run id")
        return
      }
      // Stable v2026.8.1 Gateways omit the target; newer ACKs own chat correlation
      // while the original session key continues to identify the voice relay.
      val binding = RealtimeRunCompletion.Relay(session, callId)
      val ackSessionKey = ack?.get("agentSessionKey").asStringOrNull()
      val ackAgentId = ack?.get("agentId").asStringOrNull()
      if (!isPending(pendingCall)) {
        synchronized(lock) { retireRunLocked(runId) }
        return
      }
      // Surface callbacks may take their own lifecycle locks, so never invoke one
      // while holding the coordinator lock. A final racing this callback is cached
      // against the pending call and consumed immediately after registration.
      if (isActive(session)) onWorking(session)
      val registration =
        synchronized(lock) {
          if (!isPendingLocked(pendingCall)) {
            retireRunLocked(runId)
            return
          }
          val existing = runs[runId]
          val currentObservation = observation
          val observed =
            existing?.takeIf {
              currentObservation != null && it.observationOwner === currentObservation.owner &&
                matchesObservation(currentObservation, it.agentSessionKey, it.agentId)
            }
          val earlyObservation =
            currentObservation?.takeIf { current ->
              earlyAgentEvents.any { event ->
                event.runId == runId && pendingCall in event.pending && matchesObservation(current, event.sessionKey, event.agentId)
              } ||
                earlyCompletions.any { (key, event) ->
                  key.first == runId && pendingCall in event.pendingCalls && matchesObservation(current, event.sessionKey, event.agentId)
                }
            }
          val canonicalKey = observed?.agentSessionKey ?: earlyObservation?.key
          val canonicalAgent = if (canonicalKey != null) currentObservation?.owner?.owner?.agentId else null
          val identityMismatch =
            (
              existing != null && (
                (ackSessionKey != null && ackSessionKey != existing.agentSessionKey) ||
                  (ackAgentId != null && existing.agentId != null && ackAgentId != existing.agentId) ||
                  (existing.observationOwner != null && observed == null)
              )
            ) || (
              canonicalKey != null && (
                (ackSessionKey != null && ackSessionKey != canonicalKey) ||
                  (ackAgentId != null && ackAgentId != canonicalAgent)
              )
            )
          // Missing ACK fields are unspecified. Owned early evidence can survive
          // metadata admission limits; otherwise later scoped ingress may bind it.
          val run =
            observed?.takeUnless { identityMismatch }
              ?: RealtimeAgentRun(runId, ackSessionKey ?: canonicalKey ?: session.sessionKey, ackAgentId ?: canonicalAgent, binding).also {
                it.targetUnspecified = ackSessionKey == null && canonicalKey == null
                if (canonicalKey != null && !identityMismatch) it.observationOwner = currentObservation?.owner
              }
          val cached =
            eligibleEarlyCompletionLocked(runId, run.agentSessionKey, run.agentId, pendingCall)
              ?.takeUnless { identityMismatch }
          val duplicate =
            runId in retiredRunIds ||
              runs[runId]?.completion != null ||
              earlyCompletions.any { (key, event) -> key.first == runId && pendingCall !in event.pendingCalls }
          if (cached != null && !duplicate && !identityMismatch) {
            earlyCompletions.remove(runId to cached.sessionKey)
            // A legacy keyless copy is the same run, never a separate local TTS reply.
            earlyCompletions.remove(runId to null)
          }
          pendingCalls.remove(pendingCall)
          val errorMessage =
            when {
              activeSession === session && duplicate -> {
                "tool call returned a duplicate run id"
              }

              activeSession === session && identityMismatch -> {
                "tool call returned mismatched run identity"
              }

              activeSession !== session || cached != null -> {
                retireRunLocked(runId)
                null
              }

              else -> {
                run.completion = binding
                runs[runId] = run
                earlyAgentEvents.filter { it.runId == runId && pendingCall in it.pending }.forEach { applyActivityLocked(run, it) }
                questions.values.forEach { record -> attachQuestionLocked(run, record) }
                publishActivityLocked()
                null
              }
            }
          pruneEarlyActivityLocked()
          RealtimeAgentRunRegistration(
            completion = cached.takeIf { activeSession === session && !duplicate && !identityMismatch },
            errorMessage = errorMessage,
            unhandled = drainUnclaimedCompletionsLocked(),
          )
        }
      registration.unhandled.forEach(onUnhandledCompletion)
      if (registration.errorMessage != null) {
        submitError(session, callId, registration.errorMessage)
      } else if (registration.completion != null) {
        dispatchCompletion(binding, registration.completion)
      }
    } catch (err: TimeoutCancellationException) {
      val finish = finishPending(pendingCall)
      finish.unhandled.forEach(onUnhandledCompletion)
      if (finish.canSubmitError) submitError(session, callId, "tool call timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val message = err.message ?: "tool call failed"
      val finish = finishPending(pendingCall)
      finish.unhandled.forEach(onUnhandledCompletion)
      if (finish.canSubmitError) {
        onError(session, "realtime toolCall failed: $message")
        submitError(session, callId, message)
      }
    }
  }

  private suspend fun runControl(
    session: RealtimeAgentSession,
    callId: String,
    args: JsonElement?,
  ) {
    try {
      val argsObject = args as? JsonObject
      val text =
        argsObject
          ?.get("text")
          .asStringOrNull()
          ?.trim()
          .orEmpty()
      val mode =
        argsObject
          ?.get("mode")
          .asStringOrNull()
          ?.trim()
          ?.takeIf(String::isNotEmpty)
      val params =
        buildJsonObject {
          put("sessionId", JsonPrimitive(session.relaySessionId))
          put("sessionKey", JsonPrimitive(session.sessionKey))
          put("text", JsonPrimitive(text.ifEmpty { "status" }))
          if (mode != null) put("mode", JsonPrimitive(mode))
        }
      val response = requestGateway("talk.session.steer", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
      val result = runCatching { json.parseToJsonElement(response) as? JsonObject }.getOrNull()
      if (result == null) {
        submitError(session, callId, "control call returned no result")
      } else {
        submitResult(session, callId, result)
      }
    } catch (err: TimeoutCancellationException) {
      submitError(session, callId, "control call timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      val message = err.message ?: "control call failed"
      onError(session, "realtime control failed: $message")
      submitError(session, callId, message)
    }
  }

  private fun dispatchCompletion(
    binding: RealtimeRunCompletion.Relay,
    completion: RealtimeAgentCompletion,
  ) {
    val callId = binding.callId
    val scope = synchronized(lock) { sessionScope.takeIf { activeSession === binding.session } } ?: return
    scope.launch {
      when (completion.state) {
        "final" -> {
          val text = ChatEventText.assistantTextFromMessage(completion.message).orEmpty()
          submitResult(
            binding.session,
            callId,
            buildJsonObject { put("text", JsonPrimitive(text)) },
          )
        }

        "aborted", "error" -> {
          submitError(binding.session, callId, completion.state)
        }
      }
    }
  }

  private fun failOverflowedCalls(calls: List<RealtimeAgentPendingCall>) {
    calls.forEach { it.job?.cancel() }
    calls.forEach { call ->
      val scope = synchronized(lock) { sessionScope.takeIf { activeSession === call.session } } ?: return@forEach
      val callId = call.callId ?: return@forEach
      scope.launch { submitError(call.session, callId, "tool completion correlation buffer overflow") }
    }
  }

  private suspend fun submitWorking(
    session: RealtimeAgentSession,
    callId: String,
  ) {
    submitResult(
      session = session,
      callId = callId,
      result =
        buildJsonObject {
          put("status", JsonPrimitive("working"))
          put("tool", JsonPrimitive(AGENT_CONSULT_TOOL))
          put(
            "message",
            JsonPrimitive(
              "Tell the person briefly that you are checking, then wait for the final OpenClaw result before answering with the actual result.",
            ),
          )
        },
      options = buildJsonObject { put("willContinue", JsonPrimitive(true)) },
    )
  }

  private suspend fun submitError(
    session: RealtimeAgentSession,
    callId: String,
    message: String,
  ) {
    submitResult(
      session = session,
      callId = callId,
      result = buildJsonObject { put("error", JsonPrimitive(message)) },
    )
  }

  private suspend fun submitResult(
    session: RealtimeAgentSession,
    callId: String,
    result: JsonObject,
    options: JsonObject? = null,
  ) {
    if (!isActive(session)) return
    val params =
      buildJsonObject {
        put("sessionId", JsonPrimitive(session.relaySessionId))
        put("callId", JsonPrimitive(callId))
        put("result", result)
        if (options != null) put("options", options)
      }
    try {
      requestGateway("talk.session.submitToolResult", params.toString(), TOOL_CALL_TIMEOUT_MILLIS)
    } catch (err: TimeoutCancellationException) {
      onError(session, "realtime submitToolResult timed out")
    } catch (err: CancellationException) {
      throw err
    } catch (err: Throwable) {
      onError(session, "realtime submitToolResult failed: ${err.message ?: err::class.simpleName}")
    }
  }

  private fun isActive(session: RealtimeAgentSession): Boolean = synchronized(lock) { activeSession === session }

  private fun isPending(call: RealtimeAgentPendingCall): Boolean = synchronized(lock) { isPendingLocked(call) }

  private fun isPendingLocked(call: RealtimeAgentPendingCall): Boolean = call in pendingCalls && !call.failed

  private fun clearSessionLocked(preserveObservation: Boolean = false): List<RealtimeAgentUnhandledCompletion> {
    runs.filterValues { it.completion != null }.keys.forEach(::retireRunLocked)
    activeSession = null
    sessionScope?.cancel()
    sessionScope = null
    if (preserveObservation) {
      runs.values.forEach { it.completion = null }
    } else {
      runs.clear()
      observation = null
      earlyAgentEvents.clear()
      questions.clear()
      resolvedQuestionIds.clear()
      scheduleQuestionExpiryLocked()
    }
    _activity.value = null
    return drainUnclaimedCompletionsLocked()
  }

  private fun finishPending(call: RealtimeAgentPendingCall): RealtimeAgentPendingFinish =
    synchronized(lock) {
      val removed = pendingCalls.remove(call)
      pruneEarlyActivityLocked()
      RealtimeAgentPendingFinish(
        canSubmitError = removed && !call.failed && activeSession === call.session,
        unhandled = if (removed) drainUnclaimedCompletionsLocked() else emptyList(),
      )
    }

  private fun eligibleEarlyCompletionLocked(
    runId: String,
    sessionKey: String,
    agentId: String?,
    pending: RealtimeAgentPendingCall,
  ): RealtimeAgentCompletion? {
    val expectedAgent = agentId ?: sessionKey.takeIf { it.startsWith("agent:") }?.let { resolveAgentIdFromMainSessionKey(it) }
    earlyCompletions.entries.removeAll { (key, event) ->
      val eventAgent = event.agentId ?: event.sessionKey?.takeIf { it.startsWith("agent:") }?.let { resolveAgentIdFromMainSessionKey(it) }
      key.first == runId && pending in event.pendingCalls && expectedAgent != null && eventAgent != null && eventAgent != expectedAgent
    }
    return (earlyCompletions[runId to sessionKey] ?: earlyCompletions[runId to null])?.takeIf { pending in it.pendingCalls }
  }

  private fun drainUnclaimedCompletionsLocked(): List<RealtimeAgentUnhandledCompletion> {
    val ready = earlyCompletions.filterValues { completion -> completion.pendingCalls.none(::isPendingLocked) }
    ready.keys.forEach(earlyCompletions::remove)
    return ready.map { (key, completion) -> completion.toUnhandled(key.first) }
  }

  private fun cacheEarlyCompletionLocked(
    runId: String,
    completion: RealtimeAgentCompletion,
  ): RealtimeAgentCacheOverflow? {
    // Only calls already awaiting ACK can own this event. Later calls must not
    // prolong unrelated completions or claim output produced before they started.
    earlyCompletions.putIfAbsent(runId to completion.sessionKey, completion.copy(pendingCalls = pendingCalls.filterNot { it.failed }.toSet()))
    // Bound retained result text independently of run/metadata counts.
    if (earlyCompletions.size <= maxCachedCompletions && earlyCompletions.values.sumOf {
        it.message
          ?.toString()
          ?.length
          ?.toLong() ?: 0L
      } <= MAX_CACHED_COMPLETION_CHARS
    ) {
      return null
    }
    val unhandled = earlyCompletions.map { (key, cached) -> cached.toUnhandled(key.first) }
    val failedCalls = pendingCalls.filterNot { it.failed }
    failedCalls.forEach { it.failed = true }
    earlyCompletions.clear()
    return RealtimeAgentCacheOverflow(unhandled = unhandled, failedCalls = failedCalls)
  }

  private fun retireRunLocked(runId: String) {
    retiredRunIds += runId
    while (retiredRunIds.size > maxCachedCompletions) {
      retiredRunIds.remove(retiredRunIds.first())
    }
  }

  private companion object {
    const val TAG = "RealtimeAgent"
    const val AGENT_CONSULT_TOOL = "openclaw_agent_consult"
    const val AGENT_CONTROL_TOOL = "openclaw_agent_control"
    const val TOOL_CALL_TIMEOUT_MILLIS = 15_000L
    const val MAX_CACHED_COMPLETIONS = 128
    const val MAX_CACHED_COMPLETION_CHARS = 8L * 1024 * 1024
    const val MAX_RUN_ACTIVITY_ITEMS = 64
    const val MAX_ACTIVITY_ID_CHARS = 512
    val TERMINAL_STATES = setOf("final", "aborted", "error")
  }
}

private fun RealtimeAgentCompletion.toUnhandled(runId: String) =
  RealtimeAgentUnhandledCompletion(
    sessionKey = sessionKey,
    runId = runId,
    state = state,
    message = message,
  )

private fun JsonElement?.asStringOrNull(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

private fun JsonElement?.asIdOrNull(): String? = asStringOrNull()?.takeIf { it.isNotBlank() && it.length <= 512 }

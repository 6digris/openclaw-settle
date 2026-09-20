package ai.openclaw.app.chat

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import java.time.Instant

data class BackgroundTask(
  val id: String,
  val status: String,
  val runtime: String,
  val title: String?,
  val agentId: String?,
  val childSessionKey: String?,
  val createdAtMs: Long?,
  val updatedAtMs: Long?,
  val startedAtMs: Long?,
  val endedAtMs: Long?,
  val lastActivity: String? = null,
  val progressSummary: String?,
  val terminal: String?,
  val error: String?,
  val prompt: String?,
  val sessionKey: String? = null,
  val runId: String? = null,
  val executionState: String? = null,
  val waitKind: String? = null,
  val deliveryStatus: String? = null,
  val terminalOutcome: String? = null,
  val result: String? = null,
  val progress: BackgroundTaskProgress? = null,
  val lastToolName: String? = null,
  val diffStat: ChatDiffStat? = null,
) {
  val isActive: Boolean
    get() = status == "queued" || status == "running"

  val isTerminal: Boolean
    get() = status == "completed" || status == "failed" || status == "cancelled" || status == "timed_out"

  val displayTitle: String
    get() = title?.trim()?.takeIf { it.isNotEmpty() } ?: id

  val displayStatus: BackgroundTaskDisplayStatus
    get() =
      when (status) {
        "queued" -> {
          BackgroundTaskDisplayStatus.Queued
        }

        "running" -> {
          when (executionState) {
            "running" -> BackgroundTaskDisplayStatus.Running
            "queued" -> BackgroundTaskDisplayStatus.Queued
            "waiting" -> BackgroundTaskDisplayStatus.Waiting
            "finished" -> BackgroundTaskDisplayStatus.ExecutionFinished
            else -> BackgroundTaskDisplayStatus.Unknown
          }
        }

        "completed" -> {
          if (terminalOutcome == "blocked") BackgroundTaskDisplayStatus.Blocked else BackgroundTaskDisplayStatus.Completed
        }

        "failed", "cancelled", "timed_out" -> {
          BackgroundTaskDisplayStatus.Failed
        }

        else -> {
          BackgroundTaskDisplayStatus.Unknown
        }
      }

  val output: String?
    get() {
      val candidates =
        if (status == "failed" || status == "timed_out") {
          listOf(error, result, terminal, lastActivity, progressSummary)
        } else {
          listOf(result, terminal, error, lastActivity, progressSummary)
        }
      return candidates.firstOrNull { !it.isNullOrBlank() }
    }

  val activityAtMs: Long
    get() = updatedAtMs ?: endedAtMs ?: startedAtMs ?: createdAtMs ?: 0L
}

data class BackgroundTaskProgress(
  val runId: String,
  val revision: Long,
  val items: List<ChatAgentActivity>,
)

internal sealed interface BackgroundTaskEvent {
  sealed interface Change : BackgroundTaskEvent

  data class Upserted(
    val task: BackgroundTask,
  ) : Change

  data class Deleted(
    val taskId: String,
  ) : Change

  data object Restored : BackgroundTaskEvent
}

internal sealed interface CoalescedBackgroundTaskEvent {
  data class Upserted(
    val task: BackgroundTask,
    val afterDelete: Boolean,
  ) : CoalescedBackgroundTaskEvent

  data object Deleted : CoalescedBackgroundTaskEvent
}

internal fun coalesceBackgroundTaskEvent(
  pending: MutableMap<String, CoalescedBackgroundTaskEvent>,
  event: BackgroundTaskEvent.Change,
) {
  when (event) {
    is BackgroundTaskEvent.Deleted -> {
      pending[event.taskId] = CoalescedBackgroundTaskEvent.Deleted
    }

    is BackgroundTaskEvent.Upserted -> {
      val previous = pending[event.task.id]
      pending[event.task.id] =
        CoalescedBackgroundTaskEvent.Upserted(
          task = if (previous is CoalescedBackgroundTaskEvent.Upserted) newestBackgroundTaskSnapshot(previous.task, event.task) else event.task,
          afterDelete = previous == CoalescedBackgroundTaskEvent.Deleted || (previous is CoalescedBackgroundTaskEvent.Upserted && previous.afterDelete),
        )
    }
  }
}

internal fun replayBackgroundTaskEvents(
  snapshot: List<BackgroundTask>,
  pending: Map<String, CoalescedBackgroundTaskEvent>,
): List<BackgroundTask> {
  val tasks = snapshot.associateByTo(linkedMapOf()) { it.id }
  for ((id, event) in pending) {
    when (event) {
      CoalescedBackgroundTaskEvent.Deleted -> {
        tasks.remove(id)
      }

      is CoalescedBackgroundTaskEvent.Upserted -> {
        val previous = tasks[id]
        tasks[id] = if (event.afterDelete || previous == null) event.task else newestBackgroundTaskSnapshot(previous, event.task)
      }
    }
  }
  return tasks.values.sortedWith(compareByDescending<BackgroundTask> { it.isActive }.thenByDescending { it.activityAtMs })
}

enum class BackgroundTaskDisplayStatus {
  Queued,
  Running,
  Completed,
  Failed,
  Waiting,
  ExecutionFinished,
  Blocked,
  Unknown,
}

internal fun parseBackgroundTasks(
  json: Json,
  payload: String,
): List<BackgroundTask> {
  val root = json.parseToJsonElement(payload).jsonObject
  return root["tasks"]?.jsonArray?.mapNotNull(::parseBackgroundTask).orEmpty()
}

internal fun parseBackgroundTask(element: JsonElement): BackgroundTask? {
  val objectValue = element as? JsonObject ?: return null

  fun string(key: String): String? = (objectValue[key] as? JsonPrimitive)?.contentOrNull

  val id = string("id")?.takeIf { it.isNotBlank() } ?: return null
  return BackgroundTask(
    id = id,
    status = string("status") ?: "unknown",
    runtime = string("runtime") ?: "background",
    title = string("title"),
    agentId = string("agentId"),
    childSessionKey = string("childSessionKey"),
    createdAtMs = objectValue["createdAt"]?.let(::parseTaskTimestampMs),
    updatedAtMs = objectValue["updatedAt"]?.let(::parseTaskTimestampMs),
    startedAtMs = objectValue["startedAt"]?.let(::parseTaskTimestampMs),
    endedAtMs = objectValue["endedAt"]?.let(::parseTaskTimestampMs),
    lastActivity = string("lastActivity"),
    progressSummary = string("progressSummary"),
    terminal = string("terminalSummary"),
    error = string("error"),
    prompt = string("prompt"),
    sessionKey = string("sessionKey"),
    runId = string("runId"),
    executionState = ((objectValue["execution"] as? JsonObject)?.get("state") as? JsonPrimitive)?.contentOrNull,
    waitKind = (((objectValue["execution"] as? JsonObject)?.get("wait") as? JsonObject)?.get("kind") as? JsonPrimitive)?.contentOrNull,
    deliveryStatus = string("deliveryStatus"),
    terminalOutcome = string("terminalOutcome"),
    result = string("result"),
    progress = parseBackgroundTaskProgress(objectValue["progress"]),
    lastToolName = string("lastToolName"),
    diffStat = parseChatDiffStat(objectValue["diffStat"], includeFiles = true),
  )
}

private val backgroundTaskJson = Json { ignoreUnknownKeys = true }

private fun parseBackgroundTaskProgress(element: JsonElement?): BackgroundTaskProgress? {
  val value = element as? JsonObject ?: return null
  val runId = (value["runId"] as? JsonPrimitive)?.contentOrNull?.takeIf(String::isNotBlank) ?: return null
  val revision = (value["revision"] as? JsonPrimitive)?.longOrNull?.takeIf { it >= 0 } ?: return null
  val items = value["items"] as? JsonArray ?: return null
  return BackgroundTaskProgress(
    runId = runId,
    revision = revision,
    items =
      items.take(64).mapNotNull { item ->
        runCatching { backgroundTaskJson.decodeFromJsonElement<ChatAgentActivity>(item) }
          .getOrNull()
          ?.takeIf { it.isVisible && it.kind != "reasoning" }
      },
  )
}

internal fun newestBackgroundTaskSnapshot(
  current: BackgroundTask,
  incoming: BackgroundTask,
): BackgroundTask {
  val currentAt = current.updatedAtMs ?: current.endedAtMs ?: current.createdAtMs ?: 0L
  val incomingAt = incoming.updatedAtMs ?: incoming.endedAtMs ?: incoming.createdAtMs ?: 0L
  if (incomingAt < currentAt) return current
  if (incomingAt == currentAt) {
    if (current.isTerminal && !incoming.isTerminal) return current
    if (current.isActive && incoming.isActive) {
      if (current.status == "running" && incoming.status == "queued") return current
      val previous = current.progress
      val next = incoming.progress
      // The registry revision survives replacement executions of the same canonical task run.
      if (previous != null && next != null && current.runId == incoming.runId && previous.revision > next.revision) return current
    }
  }
  return if (current.runId == incoming.runId) {
    incoming.copy(
      prompt = incoming.prompt ?: current.prompt,
      result = incoming.result ?: current.result?.takeIf { current.status == incoming.status },
    )
  } else {
    incoming
  }
}

internal fun mergeBackgroundTasks(vararg groups: List<BackgroundTask>): List<BackgroundTask> =
  groups
    .flatMap { it }
    .groupBy { it.id }
    .mapValues { (_, snapshots) ->
      snapshots.reduce(::newestBackgroundTaskSnapshot)
    }.values
    .sortedWith(compareByDescending<BackgroundTask> { it.isActive }.thenByDescending { it.activityAtMs })

internal fun parseTaskTimestampMs(element: JsonElement): Long? {
  val primitive = element as? JsonPrimitive ?: return null
  primitive.doubleOrNull?.let { return it.toLong() }
  return primitive.contentOrNull?.let { raw -> runCatching { Instant.parse(raw).toEpochMilli() }.getOrNull() }
}

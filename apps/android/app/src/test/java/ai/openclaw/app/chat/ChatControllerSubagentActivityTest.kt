package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ChatControllerSubagentActivityTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  fun taskEventsFilterAndFoldRetainedActivity() =
    runTest {
      val controller = newController()

      controller.handleGatewayEvent("task", taskPayload(id = "wrong-runtime", runtime = "cli"))
      controller.handleGatewayEvent("task", taskPayload(id = "wrong-session", sessionKey = "other"))
      assertTrue(controller.subagentActivities.value.isEmpty())

      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          progressSummary = "Planning changes",
          lastToolName = "read",
        ),
      )
      assertEquals(
        "Planning changes",
        controller.subagentActivities.value
          .getValue("task-1")
          .snippet,
      )

      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          lastActivity = "Editing ChatController",
          diffStat = Triple(2, 12, 3),
        ),
      )
      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "completed",
          terminalSummary = "Implementation complete",
        ),
      )

      val finished = controller.subagentActivities.value.getValue("task-1")
      assertEquals("completed", finished.status)
      assertEquals("Editing ChatController", finished.snippet)
      assertEquals(ChatDiffStat(added = 12, removed = 3, files = 2), finished.diffStat)
      assertEquals("Implementation complete", finished.terminalSummary)
      assertEquals("agent:worker:subagent:task-1", finished.childSessionKey)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalActivityExpiresAfterSixtySeconds() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "completed"))

      advanceTimeBy(59_999)
      runCurrent()
      assertTrue("task-1" in controller.subagentActivities.value)

      advanceTimeBy(1)
      runCurrent()
      assertTrue(controller.subagentActivities.value.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalRetentionUsesFirstLocalObservation() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent(
        "task",
        taskPayload(id = "task-1", status = "completed", endedAt = 1),
      )

      advanceTimeBy(30_000)
      runCurrent()
      assertTrue("task-1" in controller.subagentActivities.value)

      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "completed",
          terminalSummary = "Updated terminal detail",
          endedAt = 1,
        ),
      )
      assertEquals(
        "Updated terminal detail",
        controller.subagentActivities.value
          .getValue("task-1")
          .terminalSummary,
      )
      advanceTimeBy(29_999)
      runCurrent()
      assertTrue("task-1" in controller.subagentActivities.value)

      advanceTimeBy(1)
      runCurrent()
      assertTrue(controller.subagentActivities.value.isEmpty())
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun expiredTerminalRedeliveryStaysHiddenUntilANewWorkingLifecycle() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "completed"))

      advanceTimeBy(60_000)
      runCurrent()
      assertTrue(controller.subagentActivities.value.isEmpty())

      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "completed", terminalSummary = "Late duplicate"))
      assertTrue(controller.subagentActivities.value.isEmpty())

      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "running"))
      assertEquals(
        "running",
        controller.subagentActivities.value
          .getValue("task-1")
          .status,
      )

      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "completed"))
      assertEquals(
        "completed",
        controller.subagentActivities.value
          .getValue("task-1")
          .status,
      )
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun deletionAndScopeResetsAllowANewTerminalObservation() =
    runTest {
      listOf("deleted", "seqGap", "session").forEach { boundary ->
        val controller = newController()
        controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "completed"))
        advanceTimeBy(60_000)
        runCurrent()

        when (boundary) {
          "deleted" -> controller.handleGatewayEvent("task", "{\"action\":\"deleted\",\"taskId\":\"task-1\"}")
          "seqGap" -> controller.handleGatewayEvent("seqGap", null)
          "session" -> controller.switchSession("other")
        }

        controller.handleGatewayEvent(
          "task",
          taskPayload(
            id = "task-1",
            status = "completed",
            sessionKey = if (boundary == "session") "other" else "main",
          ),
        )
        assertTrue("$boundary must clear the expired observation", "task-1" in controller.subagentActivities.value)
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun terminalObservationLimitEvictsOnlyTheOldestExpiredTasks() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent("task", taskPayload(id = "still-running", status = "running"))
      repeat(101) { index ->
        controller.handleGatewayEvent("task", taskPayload(id = "task-$index", status = "completed"))
      }

      advanceTimeBy(1)
      controller.handleGatewayEvent("task", taskPayload(id = "pending-expiry", status = "completed"))
      advanceTimeBy(59_999)
      runCurrent()
      assertEquals(setOf("still-running", "pending-expiry"), controller.subagentActivities.value.keys)

      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "completed"))
      assertEquals(setOf("still-running", "pending-expiry"), controller.subagentActivities.value.keys)

      controller.handleGatewayEvent("task", taskPayload(id = "task-0", status = "completed"))
      assertEquals(setOf("still-running", "pending-expiry", "task-0"), controller.subagentActivities.value.keys)

      advanceTimeBy(1)
      runCurrent()
      assertEquals(setOf("still-running", "task-0"), controller.subagentActivities.value.keys)
    }

  @Test
  fun sessionSwitchClearsActivityButParentRunCleanupDoesNot() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "running"))

      controller.onDisconnected("offline")
      assertTrue("task-1" in controller.subagentActivities.value)

      controller.switchSession("other")
      assertTrue(controller.subagentActivities.value.isEmpty())
    }

  @Test
  fun sequenceGapClearsActivityThatCanNoLongerConverge() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "running"))

      controller.handleGatewayEvent("seqGap", null)

      assertTrue(controller.subagentActivities.value.isEmpty())
    }

  @Test
  fun errorOnlyFailureRetainsTerminalDetail() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent(
        "task",
        taskPayload(id = "task-1", status = "failed", error = "Worker could not start"),
      )

      assertEquals(
        "Worker could not start",
        controller.subagentActivities.value
          .getValue("task-1")
          .error,
      )
    }

  @Test
  fun preparedTaskSnapshotsRetractAndBecomeUnavailableWithoutCompletingTheTask() =
    runTest {
      val controller = newController()
      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          executionState = "waiting",
          progress = """{"runId":"run-task-1","revision":1,"items":[{"itemId":"work","kind":"tool","phase":"start","title":"Public activity","status":"running"},{"itemId":"hidden","kind":"tool","phase":"start","title":"Private activity","hideFromChannelProgress":true}]}""",
        ),
      )
      assertEquals(listOf("Public activity"), controller.subagentActivities.value.getValue("task-1").progress?.items?.map { it.title })
      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          executionState = "unknown",
          progress = """{"runId":"run-task-1","revision":2,"items":[]}""",
        ),
      )
      val retracted = controller.subagentActivities.value.getValue("task-1")
      assertTrue(checkNotNull(retracted.progress).items.isEmpty())
      assertTrue(retracted.isWorking)
      assertEquals("unknown", retracted.executionState)
      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          progress = """{"runId":"replacement-source","revision":1,"items":[{"itemId":"stale","kind":"tool","phase":"start","title":"Stale activity"}]}""",
        ),
      )
      assertEquals(2L, controller.subagentActivities.value.getValue("task-1").progress?.revision)
      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          progress = """{"runId":"replacement-source","revision":3,"items":[]}""",
        ),
      )
      assertEquals("replacement-source", controller.subagentActivities.value.getValue("task-1").progress?.runId)
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "completed", agentId = "another-agent"))
      assertTrue(controller.subagentActivities.value.getValue("task-1").isWorking)
      controller.handleGatewayEvent("task", """{"action":"restored"}""")
      assertTrue(controller.subagentActivities.value.isEmpty())
      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "task-1",
          status = "running",
          progress = """{"runId":"restored-source","revision":0,"items":[]}""",
        ),
      )
      assertEquals(0L, controller.subagentActivities.value.getValue("task-1").progress?.revision)
      controller.handleGatewayEvent("task", taskPayload(id = "task-1", status = "running"))
      assertNull(controller.subagentActivities.value.getValue("task-1").progress)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun quietWaitingWorkersHydrateAtRecoveryAndSelectionBoundaries() =
    runTest {
      for (boundary in listOf("connect", "reconnect", "restored", "seqGap", "session")) {
        val sessionKey = if (boundary == "session") "other" else "main"
        val controller = newController { method, params ->
          if (method == "tasks.list") {
            val request = json.parseToJsonElement(checkNotNull(params)).jsonObject
            assertEquals("main", request.getValue("agentId").jsonPrimitive.content)
            assertEquals(sessionKey, request.getValue("sessionKey").jsonPrimitive.content)
            taskList(
              taskPayload(
                id = "quiet",
                sessionKey = sessionKey,
                agentId = "main",
                status = "running",
                executionState = "waiting",
                progress = """{"runId":"restored-source","revision":0,"items":[{"itemId":"note","kind":"preamble","phase":"end","title":"","progressText":"Waiting for delegated work"}]}""",
              ),
              taskPayload(id = "another-owner", sessionKey = "agent:other:main", agentId = "other"),
            )
          } else {
            emptyChatGatewayResponse(method)
          }
        }
        when (boundary) {
          "connect" -> controller.onGatewayConnected()
          "reconnect" -> {
            controller.handleGatewayEvent("task", taskPayload(id = "quiet", status = "running"))
            controller.onDisconnected("offline")
            controller.onGatewayConnected()
          }
          "restored" -> controller.handleGatewayEvent("task", """{"action":"restored"}""")
          "seqGap" -> controller.handleGatewayEvent("seqGap", null)
          "session" -> controller.switchSession(sessionKey)
        }
        runCurrent()
        assertEquals(boundary, setOf("quiet"), controller.subagentActivities.value.keys)
        val quiet = controller.subagentActivities.value.getValue("quiet")
        assertTrue(quiet.isWorking)
        assertEquals("waiting", quiet.executionState)
        assertEquals("Waiting for delegated work", quiet.progress?.items?.single()?.progressText)
      }
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun heldHydrationReplaysLiveProgressAndDeletionWithoutLosingQuietWorkers() =
    runTest {
      val response = CompletableDeferred<String>()
      val controller = newController { method, _ ->
        if (method == "tasks.list") response.await() else emptyChatGatewayResponse(method)
      }
      controller.onGatewayConnected()
      runCurrent()
      controller.handleGatewayEvent(
        "task",
        taskPayload(
          id = "busy",
          status = "running",
          progress = """{"runId":"replacement-source","revision":2,"items":[{"itemId":"note","kind":"preamble","phase":"end","title":"","progressText":"Current work"}]}""",
        ),
      )
      controller.handleGatewayEvent("task", """{"action":"deleted","taskId":"deleted"}""")
      response.complete(
        taskList(
          taskPayload(id = "quiet", status = "running", executionState = "waiting"),
          taskPayload(id = "deleted", status = "running"),
          taskPayload(id = "busy", status = "running", progress = """{"runId":"old-source","revision":1,"items":[]}"""),
        ),
      )
      runCurrent()
      assertEquals(setOf("quiet", "busy"), controller.subagentActivities.value.keys)
      assertEquals("waiting", controller.subagentActivities.value.getValue("quiet").executionState)
      assertEquals("Current work", controller.subagentActivities.value.getValue("busy").progress?.items?.single()?.progressText)
    }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun retiredHydrationCannotPublishAcrossSocketOrSelectionChanges() =
    runTest {
      for (boundary in listOf("socket", "session", "agent", "session-aba")) {
        val response = CompletableDeferred<String>()
        var physicalConnection = 1L
        var taskReads = 0
        val request: suspend (String, String?) -> String = { method, _ ->
          if (method == "tasks.list") {
            taskReads++
            if (taskReads == 1) withContext(NonCancellable) { response.await() } else """{"tasks":[]}"""
          } else {
            emptyChatGatewayResponse(method)
          }
        }
        val controller =
          ChatController(
            scope = backgroundScope,
            commandOutbox = backgroundScope.createChatCommandOutbox(),
            cacheScope = { ChatCacheScope("gateway-test", 1L) },
            json = json,
            requestGateway = request,
            captureRequestLease = {
              val capturedConnection = physicalConnection
              GatewaySession.RequestLease("gateway-test", isCurrentImpl = { capturedConnection == physicalConnection }) { method, params, _, enqueue ->
                enqueue {}
                request(method, params)
              }
            },
          )
        controller.switchSession("global", "main")
        runCurrent()
        when (boundary) {
          "socket" -> physicalConnection++
          "session" -> controller.switchSession("other", "main")
          "agent" -> controller.switchSession("global", "other")
          "session-aba" -> {
            controller.switchSession("other", "main")
            controller.switchSession("global", "main")
          }
        }
        response.complete(taskList(taskPayload(id = "retired", status = "running", sessionKey = "global", agentId = "main")))
        runCurrent()
        assertTrue(boundary, controller.subagentActivities.value.isEmpty())
      }
    }

  private fun taskList(vararg events: String): String =
    """{"tasks":[${events.joinToString(",") { json.parseToJsonElement(it).jsonObject.getValue("task").toString() }}]}"""

  private fun TestScope.newController(
    request: suspend (String, String?) -> String = { method, _ -> emptyChatGatewayResponse(method) },
  ): ChatController =
    ChatController(
      scope = backgroundScope,
      commandOutbox = backgroundScope.createChatCommandOutbox(),
      cacheScope = { ChatCacheScope("gateway-test", 1L) },
      json = json,
      requestGateway = request,
    )

  private fun taskPayload(
    id: String,
    runtime: String = "subagent",
    sessionKey: String = "main",
    status: String = "queued",
    lastActivity: String? = null,
    progressSummary: String? = null,
    lastToolName: String? = null,
    terminalSummary: String? = null,
    error: String? = null,
    diffStat: Triple<Int, Int, Int>? = null,
    endedAt: Long? = null,
    progress: String? = null,
    executionState: String? = null,
    agentId: String? = null,
  ): String =
    buildString {
      append("{\"action\":\"upserted\",\"task\":{")
      append("\"id\":\"").append(id).append("\",")
      append("\"runId\":\"run-").append(id).append("\",")
      append("\"runtime\":\"").append(runtime).append("\",")
      append("\"sessionKey\":\"").append(sessionKey).append("\",")
      append("\"childSessionKey\":\"agent:worker:subagent:").append(id).append("\",")
      append("\"status\":\"").append(status).append("\",")
      append("\"startedAt\":1000")
      endedAt?.let { append(",\"endedAt\":").append(it) }
      progress?.let { append(",\"progress\":").append(it) }
      executionState?.let { append(",\"execution\":{\"state\":\"").append(it).append("\"}") }
      agentId?.let { append(",\"agentId\":\"").append(it).append("\"") }
      lastActivity?.let { append(",\"lastActivity\":\"").append(it).append("\"") }
      progressSummary?.let { append(",\"progressSummary\":\"").append(it).append("\"") }
      lastToolName?.let { append(",\"lastToolName\":\"").append(it).append("\"") }
      terminalSummary?.let { append(",\"terminalSummary\":\"").append(it).append("\"") }
      error?.let { append(",\"error\":\"").append(it).append("\"") }
      diffStat?.let { (files, added, removed) ->
        append(",\"diffStat\":{\"files\":").append(files)
        append(",\"added\":").append(added)
        append(",\"removed\":").append(removed).append('}')
      }
      append("}}")
    }
}

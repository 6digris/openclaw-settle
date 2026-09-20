package ai.openclaw.app.chat

import ai.openclaw.app.AndroidScreenshotFixture
import ai.openclaw.app.gateway.GatewaySession
import ai.openclaw.app.ui.chat.backgroundTasksEmptyStateVisible
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class BackgroundTaskTest {
  private val json = Json { ignoreUnknownKeys = true }

  @Test
  @OptIn(ExperimentalCoroutinesApi::class)
  fun backgroundEventsRejectRetiredConnectionsAndExcludeDetailOnlyFields() =
    runTest {
      var gatewayScope = ChatCacheScope("gateway-test", 1L)
      val controller =
        ChatController(
          scope = backgroundScope,
          commandOutbox = backgroundScope.createChatCommandOutbox(),
          cacheScope = { gatewayScope },
          json = json,
          requestGateway = { method, _ -> emptyChatGatewayResponse(method) },
        )
      val observed = mutableListOf<BackgroundTaskEvent>()
      backgroundScope.launch { controller.backgroundTaskEvents.collect { observed += it } }
      runCurrent()
      val payload =
        """{"action":"upserted","task":{"id":"task","agentId":"main","status":"running","runtime":"cli","prompt":"Private prompt","result":"Private result","progress":{"runId":"source-run","revision":1,"items":[{"itemId":"public","kind":"tool","phase":"start","title":"Public progress"}]}}}"""
      controller.handleGatewayEvent("task", payload)
      gatewayScope = gatewayScope.copy(connectionGeneration = 2L)
      runCurrent()
      assertTrue(observed.isEmpty())

      controller.handleGatewayEvent("task", payload)
      runCurrent()
      val task = (observed.single() as BackgroundTaskEvent.Upserted).task
      assertNull(task.prompt)
      assertNull(task.result)
      assertEquals(
        "Public progress",
        task.progress
          ?.items
          ?.single()
          ?.title,
      )
      controller.handleGatewayEvent("task", """{"action":"deleted","taskId":"task"}""")
      controller.handleGatewayEvent("task", """{"action":"restored"}""")
      runCurrent()
      assertEquals(listOf(BackgroundTaskEvent.Deleted("task"), BackgroundTaskEvent.Restored), observed.drop(1))
    }

  @Test
  fun listRejectsLeaseChangedAfterActiveResponse() = assertReadLeaseBoundary(revokeAfter = 1, detail = false)

  @Test
  fun listRejectsLeaseChangedAfterRecentResponse() = assertReadLeaseBoundary(revokeAfter = 2, detail = false)

  @Test
  fun detailRejectsLeaseChangedAfterResponse() = assertReadLeaseBoundary(revokeAfter = 1, detail = true)

  @Test
  fun currentLeaseReturnsBothListsAndCanonicalDetail() {
    assertReadLeaseBoundary(revokeAfter = null, detail = false)
    assertReadLeaseBoundary(revokeAfter = null, detail = true)
  }

  private fun assertReadLeaseBoundary(
    revokeAfter: Int?,
    detail: Boolean,
  ) = runTest {
    var current = true
    var captures = 0
    var calls = 0
    val reachedResponse = CompletableDeferred<Unit>()
    val releaseResponse = CompletableDeferred<Unit>()
    val fixture = AndroidScreenshotFixture.createRequester()
    val request: suspend (String, String?) -> String = { method, params ->
      calls++
      val response = fixture(method, params)
      if (calls == revokeAfter) {
        reachedResponse.complete(Unit)
        releaseResponse.await()
      }
      response
    }
    val controller =
      ChatController(
        scope = backgroundScope,
        commandOutbox = backgroundScope.createChatCommandOutbox(),
        json = json,
        cacheScope = { ChatCacheScope("gateway-test", 1L) },
        requestGateway = request,
        captureRequestLease = {
          captures++
          GatewaySession.RequestLease("gateway-test", isCurrentImpl = { current }) { method, params, _, enqueue ->
            enqueue {}
            request(method, params)
          }
        },
      )
    val result =
      async {
        runCatching {
          if (detail) listOf(controller.getBackgroundTask("screenshot-ledger-1")) else controller.listBackgroundTasks("main")
        }
      }
    if (revokeAfter != null) {
      reachedResponse.await()
      current = false
      releaseResponse.complete(Unit)
    }
    val outcome = result.await()
    if (revokeAfter != null) {
      assertTrue("A response from a retired lease must be an ordinary read failure", outcome.isFailure)
      assertFalse(outcome.exceptionOrNull() is CancellationException)
      assertEquals("No second RPC may follow a retired active response", revokeAfter, calls)
    } else {
      val tasks = outcome.getOrThrow()
      assertEquals(if (detail) 1 else 15, tasks.size)
      assertTrue(tasks.all { it.agentId == "main" })
      if (detail) assertEquals("screenshot-ledger-1", tasks.single().id)
      assertEquals(if (detail) 1 else 2, calls)
    }
    assertEquals("A logical read captures exactly one physical connection", 1, captures)
  }

  @Test
  fun unavailableLeaseFailsInsteadOfReturningAnEmptyList() =
    runTest {
      val controller =
        ChatController(
          scope = backgroundScope,
          commandOutbox = backgroundScope.createChatCommandOutbox(),
          json = json,
          requestGateway = { _, _ -> """{"tasks":[]}""" },
          captureRequestLease = { null },
        )
      for (read in listOf<suspend () -> Any>(
        { controller.listBackgroundTasks("main") },
        { controller.getBackgroundTask("screenshot-ledger-1") },
      )) {
        val failure = runCatching { read() }.exceptionOrNull()
        assertTrue("Unavailable is a read failure, not an empty success", failure != null)
        assertFalse(failure is CancellationException)
      }
    }

  @Test
  fun screenshotTasksFilterAgentAndStatusAndUseLedgerIdsForSelectableDetails() {
    val request = AndroidScreenshotFixture.createRequester()
    val tasks = parseBackgroundTasks(json, request("tasks.list", """{"agentId":"main","status":["running"],"limit":3}"""))
    assertEquals(3, tasks.size)
    assertTrue(tasks.all { it.agentId == "main" && it.status == "running" })
    val detail = json.parseToJsonElement(request("tasks.get", """{"taskId":"${tasks.first().id}"}""")).jsonObject["task"]!!
    val parsed = checkNotNull(parseBackgroundTask(detail))
    assertTrue(checkNotNull(parsed.prompt).contains("Checklist section 24"))
    assertTrue(checkNotNull(parsed.output).contains("Result section 24"))
    assertTrue(runCatching { request("tasks.get", """{"taskId":"screenshot-runtime-1"}""") }.isFailure)
    assertTrue(runCatching { request("tasks.cancel", """{"taskId":"screenshot-ledger-1"}""") }.isFailure)
  }

  @Test
  fun parsesPromptAndOutputFromTaskDetails() {
    val tasks =
      parseBackgroundTasks(
        json,
        """{"tasks":[{"id":"task-1","taskId":"worker-1","status":"failed","runtime":"cli","title":"Index docs","startedAt":1000,"endedAt":"2026-07-16T09:00:00Z","error":"Command failed","prompt":"Index the docs"}]}""",
      )

    assertEquals(1, tasks.size)
    assertEquals("Index docs", tasks.single().displayTitle)
    assertEquals("Index the docs", tasks.single().prompt)
    assertEquals("Command failed", tasks.single().output)
    assertEquals(BackgroundTaskDisplayStatus.Failed, tasks.single().displayStatus)
    assertFalse(tasks.single().isActive)
  }

  @Test
  fun runningLedgerStatusDoesNotInventExecutionLiveness() {
    val tasks =
      parseBackgroundTasks(
        json,
        """{"tasks":[{"id":"task-exec","taskId":"task-exec","kind":"exec","status":"running","runtime":"cli","title":"CLI command","progressSummary":"Command running"}]}""",
      )

    assertEquals(1, tasks.size)
    assertEquals("CLI command", tasks.single().displayTitle)
    assertEquals("Command running", tasks.single().output)
    assertTrue(tasks.single().isActive)
    assertEquals(BackgroundTaskDisplayStatus.Unknown, tasks.single().displayStatus)
  }

  @Test
  fun runningTaskPrefersLiveActivityOverProgressSummary() {
    val task =
      parseBackgroundTasks(
        json,
        """{"tasks":[{"id":"task-activity","status":"running","runtime":"subagent","lastActivity":"Editing timeline rows","progressSummary":"Initial milestone"}]}""",
      ).single()

    assertEquals("Editing timeline rows", task.output)
  }

  @Test
  fun executionAndDeliveryAreIndependentOfTaskOutcome() {
    fun task(
      status: String,
      execution: String,
      outcome: String? = null,
    ): BackgroundTask =
      parseBackgroundTasks(
        json,
        """{"tasks":[{"id":"task","status":"$status","execution":{"state":"$execution","wait":{"kind":"children"}},"deliveryStatus":"pending","terminalOutcome":${outcome?.let { "\"$it\"" } ?: "null"}}]}""",
      ).single()

    val waiting = task("running", "waiting")
    assertTrue(waiting.isActive)
    assertEquals(BackgroundTaskDisplayStatus.Waiting, waiting.displayStatus)
    assertEquals("children", waiting.waitKind)
    val executionFinished = task("running", "finished")
    assertTrue(executionFinished.isActive)
    assertFalse(executionFinished.isTerminal)
    assertEquals(BackgroundTaskDisplayStatus.ExecutionFinished, executionFinished.displayStatus)
    val completed = task("completed", "finished", "succeeded")
    assertEquals(BackgroundTaskDisplayStatus.Completed, completed.displayStatus)
    assertEquals("pending", completed.deliveryStatus)
    assertEquals(BackgroundTaskDisplayStatus.Blocked, task("completed", "finished", "blocked").displayStatus)
  }

  @Test
  fun preparedProgressIsBoundedRedactedAndOrderedAcrossPhysicalExecutions() {
    val items =
      (0..64).joinToString(",") { index ->
        """{"itemId":"item-$index","kind":"tool","phase":"start","title":"Public $index","status":"running","args":{"token":"private"},"hideFromChannelProgress":${index == 0}}"""
      }

    fun task(
      progress: String,
      activityAt: Long = 200,
    ): BackgroundTask = parseBackgroundTasks(json, """{"tasks":[{"id":"task","status":"running","runId":"run-1","execution":{"state":"running","lastActivityAt":$activityAt},"progress":$progress}]}""").single()

    val original = task("""{"runId":"run-1","revision":7,"items":[$items]}""")
    val progress = checkNotNull(original.progress)
    assertEquals((1..63).map { "Public $it" }, progress.items.map { it.title })
    assertEquals("run-1", progress.runId)
    assertEquals(7L, progress.revision)
    val successor = task("""{"runId":"resumed-source-run","revision":8,"items":[]}""", activityAt = 100)
    assertEquals("resumed-source-run", mergeBackgroundTasks(listOf(original), listOf(successor)).single().progress?.runId)
    assertEquals("resumed-source-run", mergeBackgroundTasks(listOf(successor), listOf(original)).single().progress?.runId)
    val retraction = task("""{"runId":"run-1","revision":8,"items":[]}""")
    assertTrue(checkNotNull(mergeBackgroundTasks(listOf(original), listOf(retraction)).single().progress).items.isEmpty())
    assertTrue(checkNotNull(mergeBackgroundTasks(listOf(retraction), listOf(original)).single().progress).items.isEmpty())
    assertNull(mergeBackgroundTasks(listOf(original), listOf(task("null"))).single().progress)
    val preamble =
      task(
        """{"runId":"source-run","revision":1,"items":[{"itemId":"public","kind":"preamble","phase":"end","title":"","progressText":"Public progress note"},{"itemId":"reasoning","kind":"reasoning","phase":"end","title":"Private reasoning"},{"itemId":"quiet","kind":"tool","phase":"end","title":"Suppressed tool","suppressChannelProgress":true}]}""",
      )
    assertEquals(
      "Public progress note",
      preamble.progress
        ?.items
        ?.single()
        ?.progressText,
    )
  }

  @Test
  fun listsActiveAndRecentTasksWithoutRequestingPrompts() =
    runTest {
      val calls = mutableListOf<Pair<String, String?>>()
      val controller =
        ChatController(
          scope = backgroundScope,
          commandOutbox = backgroundScope.createChatCommandOutbox(),
          cacheScope = { ChatCacheScope("gateway-test", 1L) },
          json = json,
          requestGateway = { method, params ->
            calls += method to params
            """{"tasks":[]}"""
          },
        )

      assertTrue(controller.listBackgroundTasks("main").isEmpty())
      assertEquals(listOf("tasks.list", "tasks.list"), calls.map { it.first })
      val statuses =
        calls.map { (_, params) ->
          json
            .parseToJsonElement(params.orEmpty())
            .jsonObject["status"]!!
            .jsonArray
            .map { it.jsonPrimitive.content }
        }
      assertEquals(listOf("queued", "running"), statuses[0])
      assertEquals(listOf("completed", "failed", "cancelled", "timed_out"), statuses[1])
      assertNull(json.parseToJsonElement(calls[0].second.orEmpty()).jsonObject["prompt"])
    }

  @Test
  fun requestsTaskDetailsByCanonicalLedgerId() =
    runTest {
      var requestedParams: String? = null
      val controller =
        ChatController(
          scope = backgroundScope,
          commandOutbox = backgroundScope.createChatCommandOutbox(),
          cacheScope = { ChatCacheScope("gateway-test", 1L) },
          json = json,
          requestGateway = { method, params ->
            assertEquals("tasks.get", method)
            requestedParams = params
            """{"task":{"id":"ledger-1","taskId":"runtime-1","status":"completed","runtime":"cli"}}"""
          },
        )

      val task = controller.getBackgroundTask("ledger-1")

      assertEquals("ledger-1", task.id)
      assertEquals(
        "ledger-1",
        json
          .parseToJsonElement(requestedParams.orEmpty())
          .jsonObject["taskId"]
          ?.jsonPrimitive
          ?.content,
      )
    }

  @Test
  fun newestTaskSnapshotWinsDuplicateAndGroupsActiveFirst() {
    val finished = sampleTask(id = "same", status = "completed", endedAtMs = 2000)
    val running = sampleTask(id = "same", status = "running", endedAtMs = 3000)
    val older = sampleTask(id = "older", status = "failed", endedAtMs = 1000)

    val merged = mergeBackgroundTasks(listOf(finished, older), listOf(running))

    assertEquals(listOf("same", "older"), merged.map { it.id })
    assertTrue(merged.first().isActive)
  }

  @Test
  fun terminalSnapshotWinsTimestampTie() {
    val running = sampleTask(id = "same", status = "running", endedAtMs = 2000)
    val finished = sampleTask(id = "same", status = "completed", endedAtMs = 2000)

    val merged = mergeBackgroundTasks(listOf(running), listOf(finished))

    assertEquals("completed", merged.single().status)
  }

  @Test
  fun snapshotReplayPreservesQuietRowsAndDoesNotResurrectDeletedGenerations() {
    val quiet = sampleTask("quiet", "queued", 100)
    val original =
      sampleTask("changing", "running", 200).copy(
        runId = "canonical",
        prompt = "Retired private prompt",
        progress = BackgroundTaskProgress("old-source", 8, emptyList()),
      )
    val pending = mutableMapOf<String, CoalescedBackgroundTaskEvent>()
    coalesceBackgroundTaskEvent(pending, BackgroundTaskEvent.Upserted(original.copy(progress = null)))
    val unavailable = replayBackgroundTaskEvents(listOf(quiet, original), pending)
    assertEquals(setOf("quiet", "changing"), unavailable.map { it.id }.toSet())
    assertNull(unavailable.single { it.id == "changing" }.progress)

    coalesceBackgroundTaskEvent(pending, BackgroundTaskEvent.Deleted("changing"))
    coalesceBackgroundTaskEvent(
      pending,
      BackgroundTaskEvent.Upserted(
        sampleTask("changing", "running", 1).copy(
          title = "Replacement task",
          runId = "replacement",
          progress = BackgroundTaskProgress("new-source", 0, emptyList()),
        ),
      ),
    )
    val replacement = replayBackgroundTaskEvents(listOf(quiet, original), pending).single { it.id == "changing" }
    assertEquals("Replacement task", replacement.displayTitle)
    assertEquals(0L, replacement.progress?.revision)
    assertNull(replacement.prompt)
    coalesceBackgroundTaskEvent(pending, BackgroundTaskEvent.Deleted("changing"))
    assertEquals(listOf("quiet"), replayBackgroundTaskEvents(listOf(quiet, original), pending).map { it.id })
  }

  @Test
  fun finishedProtocolStatusesUseTheBinaryFailedPresentation() {
    assertEquals(
      BackgroundTaskDisplayStatus.Failed,
      sampleTask(id = "cancelled", status = "cancelled", endedAtMs = 2000).displayStatus,
    )
    assertEquals(
      BackgroundTaskDisplayStatus.Failed,
      sampleTask(id = "timed-out", status = "timed_out", endedAtMs = 2000).displayStatus,
    )
  }

  @Test
  fun emptyStateDoesNotMaskLoadFailure() {
    assertTrue(backgroundTasksEmptyStateVisible(loading = false, error = null, taskCount = 0))
    assertFalse(backgroundTasksEmptyStateVisible(loading = false, error = "offline", taskCount = 0))
  }

  private fun sampleTask(
    id: String,
    status: String,
    endedAtMs: Long?,
  ) = BackgroundTask(
    id = id,
    status = status,
    runtime = "cli",
    title = id,
    agentId = "main",
    childSessionKey = null,
    createdAtMs = 100,
    updatedAtMs = endedAtMs,
    startedAtMs = 500,
    endedAtMs = endedAtMs,
    progressSummary = null,
    terminal = null,
    error = null,
    prompt = null,
  )
}

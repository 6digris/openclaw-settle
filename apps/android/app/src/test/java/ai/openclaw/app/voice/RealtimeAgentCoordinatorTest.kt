package ai.openclaw.app.voice

import ai.openclaw.app.chat.ChatComposerOwner
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import kotlin.time.Duration.Companion.seconds

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class RealtimeAgentCoordinatorTest {
  private lateinit var calls: MutableList<GatewayCall>

  @Test
  fun `keyless duplicate stays quarantined when an owned completion is claimed or stopped`() =
    runTest {
      for (stopped in listOf(false, true)) {
        for (keylessFirst in listOf(false, true)) {
          val response = CompletableDeferred<String>()
          val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
          val coordinator =
            coordinator(
              responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
              onUnhandledCompletion = unhandled::add,
            )
          coordinator.beginSession(RealtimeAgentSession("relay-1", "main"))
          coordinator.consult("call-1")
          runCurrent()
          val keys = listOf(null, "agent:voice:main").let { if (keylessFirst) it else it.reversed() }
          keys.forEach { assertTrue(coordinator.complete(it, "run-1", "owned")) }
          if (stopped) coordinator.endSession()
          response.complete("""{"runId":"run-1","agentSessionKey":"agent:voice:main"}""")
          runCurrent()

          assertTrue("Compatible duplicate escaped into ordinary TTS", unhandled.isEmpty())
          assertEquals(if (stopped) 0 else 1, calls.count { it.method == "talk.session.submitToolResult" })
          coordinator.endSession()
        }
      }
    }

  @Test
  fun `wrong session early final cannot displace the owned final`() =
    runTest {
      val response = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "main"))
      coordinator.consult("call-1")
      runCurrent()
      assertTrue(coordinator.complete("other-session", "run-1", "private"))
      assertTrue(coordinator.complete("agent:voice:main", "run-1", "owned"))
      response.complete("""{"runId":"run-1","agentSessionKey":"agent:voice:main"}""")
      runCurrent()

      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"text\":\"owned\""))
      assertEquals(listOf("other-session"), unhandled.map { it.sessionKey })
    }

  @Test
  fun `later duplicate ack cannot steal an earlier pending completion`() =
    runTest {
      val responses = List(2) { CompletableDeferred<String>() }
      var requestIndex = 0
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") responses[requestIndex++].await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "main"))
      coordinator.consult("call-1")
      runCurrent()
      assertTrue(coordinator.complete("agent:voice:main", "run-1", "owned"))
      coordinator.consult("call-2")
      runCurrent()
      val ack = """{"runId":"run-1","agentSessionKey":"agent:voice:main"}"""
      responses[1].complete(ack)
      runCurrent()
      responses[0].complete(ack)
      runCurrent()

      val results = calls.filter { it.method == "talk.session.submitToolResult" }.map { Json.parseToJsonElement(it.params).jsonObject }
      assertEquals(2, results.size)
      assertEquals(
        "tool call returned a duplicate run id",
        results
          .single { it.getValue("callId").jsonPrimitive.content == "call-2" }
          .getValue("result")
          .jsonObject
          .getValue("error")
          .jsonPrimitive.content,
      )
      assertEquals(
        "owned",
        results
          .single { it.getValue("callId").jsonPrimitive.content == "call-1" }
          .getValue("result")
          .jsonObject
          .getValue("text")
          .jsonPrimitive.content,
      )
    }

  @Test
  fun `consult follows acknowledged ownership before and after the ack`() =
    runTest {
      for ((voiceKey, agentKey) in listOf("main" to "agent:voice:main", "global" to "global")) {
        for (early in listOf(false, true)) {
          val response = CompletableDeferred<String>()
          val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
          val coordinator =
            coordinator(
              responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
              onUnhandledCompletion = unhandled::add,
            )
          coordinator.beginSession(RealtimeAgentSession("relay-1", voiceKey))
          coordinator.consult("call-1")
          runCurrent()

          if (early) {
            assertTrue(coordinator.complete("other-session", "unrelated-run", "private"))
            assertTrue(coordinator.complete(agentKey, "run-1", "done"))
            runCurrent()
            assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
          }
          response.complete("""{"runId":"run-1","agentId":"voice","agentSessionKey":"$agentKey"}""")
          runCurrent()
          if (!early) {
            assertFalse(coordinator.complete("other-session", "run-1", "private"))
            assertTrue(coordinator.complete(agentKey, "run-1", "done"))
            runCurrent()
          }

          val consult = calls.single { it.method == "talk.client.toolCall" }
          assertEquals(
            voiceKey,
            Json
              .parseToJsonElement(consult.params)
              .jsonObject
              .getValue("sessionKey")
              .jsonPrimitive.content,
          )
          val result = calls.single { it.method == "talk.session.submitToolResult" }
          val params = Json.parseToJsonElement(result.params).jsonObject
          assertEquals("relay-1", params.getValue("sessionId").jsonPrimitive.content)
          assertEquals(
            "done",
            params
              .getValue("result")
              .jsonObject
              .getValue("text")
              .jsonPrimitive.content,
          )
          assertEquals(if (early) listOf("unrelated-run") else emptyList(), unhandled.map { it.runId })
          coordinator.endSession()
        }
      }
    }

  @Test
  fun `consult correlates the active run and submits its final text`() =
    runTest {
      val working = mutableListOf<RealtimeAgentSession>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") """{"runId":"run-1"}""" else "{}" },
          onWorking = working::add,
        )
      val session = RealtimeAgentSession("relay-1", "session-1")
      coordinator.beginSession(session)

      assertTrue(coordinator.consult("call-1"))
      runCurrent()

      assertEquals(listOf(session), working)
      assertFalse(coordinator.complete("other-session", "run-1", "wrong"))
      assertTrue(coordinator.complete("session-1", "run-1", "done"))
      runCurrent()

      val consult = calls.single { it.method == "talk.client.toolCall" }
      assertEquals(15_000L, consult.timeoutMs)
      assertTrue(consult.params.contains("\"name\":\"openclaw_agent_consult\""))
      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"sessionId\":\"relay-1\""))
      assertTrue(result.params.contains("\"callId\":\"call-1\""))
      assertTrue(result.params.contains("\"text\":\"done\""))
    }

  @Test
  fun `early completion waits for run metadata`() =
    runTest {
      val response = CompletableDeferred<String>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))
      coordinator.consult("call-1")
      runCurrent()

      assertTrue(coordinator.complete("session-1", "run-early", "early"))
      response.complete("""{"runId":"run-early"}""")
      runCurrent()

      assertTrue(
        calls
          .single { it.method == "talk.session.submitToolResult" }
          .params
          .contains("\"text\":\"early\""),
      )
    }

  @Test
  fun `validates tool names and dispatches control without a consult`() =
    runTest {
      val coordinator =
        coordinator(
          responses = { method ->
            when (method) {
              "talk.session.steer" -> """{"status":"steered"}"""
              else -> "{}"
            }
          },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))

      coordinator.handleToolCall(
        callId = "control-1",
        name = "openclaw_agent_control",
        args = Json.parseToJsonElement("""{"text":"stop","mode":"cancel"}"""),
        forced = false,
      )
      coordinator.handleToolCall(
        callId = "unknown-1",
        name = "other_tool",
        args = null,
        forced = false,
      )
      runCurrent()

      assertTrue(calls.none { it.method == "talk.client.toolCall" })
      val steer = calls.single { it.method == "talk.session.steer" }
      assertTrue(steer.params.contains("\"mode\":\"cancel\""))
      val results = calls.filter { it.method == "talk.session.submitToolResult" }
      assertTrue(results.any { it.params.contains("\"status\":\"steered\"") })
      assertTrue(results.any { it.params.contains("unsupported realtime Talk tool: other_tool") })
    }

  @Test
  fun `forced consult reports working then returns gateway errors`() =
    runTest {
      val errors = mutableListOf<String>()
      val coordinator =
        coordinator(
          responses = { method ->
            if (method == "talk.client.toolCall") error("gateway offline") else "{}"
          },
          onError = errors::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))

      coordinator.consult("call-1", forced = true)
      runCurrent()

      val results = calls.filter { it.method == "talk.session.submitToolResult" }
      assertEquals(2, results.size)
      assertTrue(results[0].params.contains("\"status\":\"working\""))
      assertTrue(results[0].params.contains("\"willContinue\":true"))
      assertTrue(results[1].params.contains("\"error\":\"gateway offline\""))
      assertEquals(listOf("realtime toolCall failed: gateway offline"), errors)
    }

  @Test
  fun `session replacement quarantines the old run while a call id is reused`() =
    runTest {
      val oldResponse = CompletableDeferred<String>()
      val newResponse = CompletableDeferred<String>()
      var requestCount = 0
      val coordinator =
        coordinator(
          responses = { method ->
            if (method != "talk.client.toolCall") {
              "{}"
            } else if (requestCount++ == 0) {
              oldResponse.await()
            } else {
              newResponse.await()
            }
          },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-shared")
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      coordinator.consult("call-shared")
      runCurrent()

      assertTrue(coordinator.complete("session-main", "run-new", "fresh"))
      newResponse.complete("""{"runId":"run-new"}""")
      runCurrent()

      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"sessionId\":\"relay-new\""))
      assertTrue(result.params.contains("\"text\":\"fresh\""))

      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()
      assertTrue(coordinator.complete("session-main", "run-old", "stale"))
      assertEquals(1, calls.count { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `transport reset cancels an old consult before a new gateway session`() =
    runTest {
      val oldResponse = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") oldResponse.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      coordinator.consult("call-old-2")
      runCurrent()
      assertTrue(coordinator.complete("session-main", "cached-old-run", "stale cached"))

      coordinator.resetTransport()
      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
      assertTrue(unhandled.isEmpty())
      assertFalse(coordinator.complete("session-main", "run-old", "stale"))
    }

  @Test
  fun `transport reset rejects a reused retired run id without stranding the call`() =
    runTest {
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") """{"runId":"shared-run"}""" else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.resetTransport()
      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      coordinator.consult("call-new")
      runCurrent()

      assertTrue(coordinator.complete("session-main", "shared-run", "late"))
      runCurrent()

      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("\"sessionId\":\"relay-new\""))
      assertTrue(result.params.contains("\"callId\":\"call-new\""))
      assertTrue(result.params.contains("tool call returned a duplicate run id"))
    }

  @Test
  fun `old session request releases an unrelated completion after its ack`() =
    runTest {
      val oldResponse = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") oldResponse.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-old"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-new"))

      assertTrue(coordinator.complete("session-new", "ordinary-run", "ordinary"))
      oldResponse.complete("""{"runId":"run-old"}""")
      runCurrent()
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
      assertEquals(listOf("ordinary-run"), unhandled.map { it.runId })
    }

  @Test
  fun `new pending calls cannot prolong an unrelated early completion`() =
    runTest {
      val responses = List(2) { CompletableDeferred<String>() }
      var requestIndex = 0
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") responses[requestIndex++].await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))
      coordinator.consult("call-1")
      runCurrent()
      assertTrue(coordinator.complete("session-1", "ordinary-run", "ordinary"))
      coordinator.consult("call-2")
      runCurrent()

      responses[0].complete("""{"runId":"run-1"}""")
      runCurrent()

      assertEquals(listOf("ordinary-run"), unhandled.map { it.runId })
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
      responses[1].complete("""{"runId":"run-2"}""")
      runCurrent()
      coordinator.endSession()
    }

  @Test
  fun `session replacement consumes a known old run with the same session key`() =
    runTest {
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") """{"runId":"run-old"}""" else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))

      assertTrue(coordinator.complete("session-main", "run-old", "stale"))
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `session end retains unresolved correlation and quarantines its final`() =
    runTest {
      val response = CompletableDeferred<String>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.endSession("relay-old")
      assertTrue(coordinator.complete("session-main", "run-old", "stale"))
      response.complete("""{"runId":"run-old"}""")
      runCurrent()

      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `session end suppresses a late gateway failure`() =
    runTest {
      val response = CompletableDeferred<String>()
      val errors = mutableListOf<String>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
          onError = errors::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()

      coordinator.endSession("relay-old")
      response.completeExceptionally(IllegalStateException("late failure"))
      runCurrent()

      assertTrue(errors.isEmpty())
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `session cleanup releases uncertain early completions`() =
    runTest {
      val response = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator =
        coordinator(
          responses = { method -> if (method == "talk.client.toolCall") response.await() else "{}" },
          onUnhandledCompletion = unhandled::add,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-old", "session-main"))
      coordinator.consult("call-old")
      runCurrent()
      assertTrue(coordinator.complete("session-main", "uncertain-run", "ordinary"))

      coordinator.beginSession(RealtimeAgentSession("relay-new", "session-main"))
      response.complete("""{"runId":"old-tool-run"}""")
      runCurrent()

      assertEquals(listOf("uncertain-run"), unhandled.map { it.runId })
      assertEquals("final", unhandled.single().state)
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun `early completion overflow fails pending calls instead of stranding them`() =
    runTest {
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val responses = List(3) { CompletableDeferred<String>() }
      var responseIndex = 0
      val coordinator =
        coordinator(
          responses = { method ->
            if (method == "talk.client.toolCall") responses[responseIndex++].await() else "{}"
          },
          onUnhandledCompletion = unhandled::add,
          maxCachedCompletions = 2,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))
      repeat(3) { index ->
        coordinator.consult("call-${index + 1}")
      }
      runCurrent()
      repeat(3) { index ->
        coordinator.complete("session-1", "run-${index + 1}", "result-${index + 1}")
      }
      runCurrent()
      responses.take(2).forEachIndexed { index, response -> response.complete("""{"runId":"run-${index + 1}"}""") }
      runCurrent()

      val submittedResults =
        calls
          .filter { it.method == "talk.session.submitToolResult" }
          .associate { call ->
            val params = Json.parseToJsonElement(call.params) as JsonObject
            params.getValue("callId").jsonPrimitive.content to call.params
          }
      assertTrue(submittedResults.getValue("call-1").contains("correlation buffer overflow"))
      assertTrue(submittedResults.getValue("call-2").contains("correlation buffer overflow"))
      assertTrue(submittedResults.getValue("call-3").contains("too many concurrent"))
      assertEquals(listOf("run-1", "run-2", "run-3"), unhandled.map { it.runId })
      assertEquals(2, calls.count { it.method == "talk.client.toolCall" })
    }

  @Test
  fun `registered runs count against the concurrent call limit`() =
    runTest {
      var runIndex = 0
      val coordinator =
        coordinator(
          responses = { method ->
            if (method == "talk.client.toolCall") """{"runId":"run-${++runIndex}"}""" else "{}"
          },
          maxCachedCompletions = 2,
        )
      coordinator.beginSession(RealtimeAgentSession("relay-1", "session-1"))

      repeat(3) { index ->
        coordinator.consult("call-${index + 1}")
        runCurrent()
      }

      assertEquals(2, calls.count { it.method == "talk.client.toolCall" })
      val rejection = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(rejection.params.contains("\"callId\":\"call-3\""))
      assertTrue(rejection.params.contains("too many concurrent realtime Talk tool calls"))
    }

  @Test
  fun activityWaitsForExactAckIdentityAndRejectsForeignOrOutOfOrderEvents() =
    runTest {
      val ack = CompletableDeferred<String>()
      val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" })
      coordinator.beginSession(RealtimeAgentSession("relay", "global"))
      coordinator.consult("consult")
      runCurrent()

      fun event(
        agentId: String,
        sequence: Int,
        name: String,
      ) = Json
        .parseToJsonElement(
          """{"runId":"owned-run","sessionKey":"global","agentId":"$agentId","seq":$sequence,"stream":"tool","data":{"phase":"start","toolCallId":"tool-1","name":"$name"}}""",
        ).jsonObject
      coordinator.handleAgentEvent(event("foreign", 100, "write"))
      coordinator.handleAgentEvent(event("scout", 2, "read"))
      assertEquals(null, coordinator.activity.value)
      ack.complete("""{"runId":"owned-run","agentId":"scout","agentSessionKey":"global"}""")
      runCurrent()
      assertEquals(TalkAgentActivity.Reading, coordinator.activity.value?.activity)
      coordinator.handleAgentEvent(event("scout", 1, "edit"))
      coordinator.handleAgentEvent(event("foreign", 101, "edit"))
      assertEquals(TalkAgentActivity.Reading, coordinator.activity.value?.activity)
      coordinator.complete("global", "owned-run", "Done")
      runCurrent()
      assertEquals(null, coordinator.activity.value)
      coordinator.handleAgentEvent(event("scout", 3, "write"))
      assertEquals(null, coordinator.activity.value)
    }

  @Test
  fun completedBeforeAckNeverRevivesItsCachedToolActivity() =
    runTest {
      val ack = CompletableDeferred<String>()
      val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" })
      coordinator.beginSession(RealtimeAgentSession("relay", "agent:scout:call"))
      coordinator.consult("consult")
      runCurrent()
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"owned-run","sessionKey":"agent:scout:call","agentId":"scout","seq":1,"stream":"tool","data":{"phase":"start","toolCallId":"tool-1","name":"read"}}""").jsonObject)
      coordinator.complete("agent:scout:call", "owned-run", "Done")
      ack.complete("""{"runId":"owned-run","agentId":"scout","agentSessionKey":"agent:scout:call"}""")
      runCurrent()
      assertEquals(null, coordinator.activity.value)
    }

  @Test
  fun replacementWithSameRelayAndChatCannotAcquireOldPendingWork() =
    runTest {
      val ack = CompletableDeferred<String>()
      val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" })
      coordinator.beginSession(RealtimeAgentSession("relay", "agent:scout:call"))
      coordinator.consult("old-consult")
      runCurrent()
      coordinator.endSession()
      coordinator.beginSession(RealtimeAgentSession("relay", "agent:scout:call"))
      ack.complete("""{"runId":"old-run","agentId":"scout","agentSessionKey":"agent:scout:call"}""")
      runCurrent()
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"old-run","sessionKey":"agent:scout:call","agentId":"scout","seq":1,"stream":"tool","data":{"phase":"start","toolCallId":"tool-1","name":"read"}}""").jsonObject)
      assertEquals(null, coordinator.activity.value)
      assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
    }

  @Test
  fun nativeChatSendUsesTheSameActivityFencesWithoutSubmittingAProviderResult() =
    runTest {
      val completed = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator = coordinator(responses = { error("Native observation must not send an RPC") }, onUnhandledCompletion = completed::add)
      coordinator.beginSession(RealtimeAgentSession(null, "agent:scout:call"))
      val pending = coordinator.beginChatSend()
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"native-run","sessionKey":"agent:scout:call","agentId":"scout","seq":1,"stream":"tool","data":{"phase":"start","toolCallId":"tool-1","name":"read"}}""").jsonObject)
      assertEquals(null, coordinator.activity.value)
      coordinator.finishChatSend(pending, "native-run", "scout")
      assertEquals(TalkAgentActivity.Reading, coordinator.activity.value?.activity)
      assertFalse(coordinator.complete("agent:scout:call", "native-run", "Native reply belongs to native TTS"))
      assertEquals(null, coordinator.activity.value)
      assertTrue(calls.isEmpty())

      val early = coordinator.beginChatSend()
      assertTrue(coordinator.complete("agent:scout:call", "early-native-run", "Early native reply"))
      coordinator.finishChatSend(early, "early-native-run", "scout")
      assertEquals(listOf("early-native-run"), completed.map { it.runId })
      assertEquals(null, coordinator.activity.value)
      assertTrue(calls.isEmpty())
    }

  @Test
  fun preAckQuestionCannotBeClaimedByAnotherRunOrByMissingRunIdentity() =
    runTest {
      for (native in listOf(false, true)) {
        for (hasRunId in listOf(false, true)) {
          val responses = List(2) { CompletableDeferred<String>() }
          var requestIndex = 0
          val coordinator =
            coordinator(responses = { method ->
              if (method == "talk.client.toolCall") responses[requestIndex++].await() else "{}"
            })
          val key = "agent:scout:call"
          coordinator.beginSession(RealtimeAgentSession(if (native) null else "relay", key))
          val pendingA = if (native) coordinator.beginChatSend() else null
          val pendingB = if (native) coordinator.beginChatSend() else null
          if (!native) {
            coordinator.consult("consult-A")
            coordinator.consult("consult-B")
            runCurrent()
          }
          val runMember = if (hasRunId) "\"runId\":\"run-A\"," else ""
          val expires = System.currentTimeMillis() + 60_000
          coordinator.handleQuestionEvent(
            "question.requested",
            Json
              .parseToJsonElement(
                """{"id":"question-A",$runMember"agentId":"scout","sessionKey":"$key","questions":[],"createdAtMs":0,"expiresAtMs":$expires,"status":"pending"}""",
              ).jsonObject,
          )
          if (native) {
            coordinator.finishChatSend(pendingB, "run-B", "scout")
          } else {
            responses[1].complete("""{"runId":"run-B","agentId":"scout","agentSessionKey":"$key"}""")
          }
          runCurrent()
          assertEquals("ACK B must not inherit A's question (native=$native, hasRunId=$hasRunId)", TalkAgentActivity.Thinking, coordinator.activity.value?.activity)
          if (native) {
            coordinator.finishChatSend(pendingA, "run-A", "scout")
          } else {
            responses[0].complete("""{"runId":"run-A","agentId":"scout","agentSessionKey":"$key"}""")
          }
          runCurrent()
          assertEquals(if (hasRunId) TalkAgentActivity.WaitingForInput else TalkAgentActivity.Thinking, coordinator.activity.value?.activity)
          coordinator.handleQuestionEvent("question.resolved", Json.parseToJsonElement("""{"id":"question-A","status":"answered"}""").jsonObject)
          assertEquals(TalkAgentActivity.Thinking, coordinator.activity.value?.activity)
          assertTrue(calls.none { it.method == "talk.session.submitToolResult" })
          coordinator.endSession()
        }
      }
    }

  @Test
  fun observedOnlyRunsCannotStarveNativeInputCapacity() = verifyObservedInputCapacity(native = true)

  @Test
  fun observedOnlyRunsCannotStarveRelayInputCapacity() = verifyObservedInputCapacity(native = false)

  private fun verifyObservedInputCapacity(native: Boolean) =
    runTest {
      run {
        val key = "agent:scout:call"
        val coordinator =
          coordinator(responses = { method ->
            if (method == "talk.client.toolCall") {
              """{"runId":"real-input","agentId":"scout","agentSessionKey":"$key"}"""
            } else {
              "{}"
            }
          })
        val owner =
          TalkModeManager.ChatStart(
            ChatComposerOwner("capacity-fixture", "scout", key),
            GatewaySession.RequestLease("capacity-fixture") { _, _, _, enqueue ->
              enqueue {}
              "{}"
            },
            withCurrentSelection = { it() },
            isCurrentSelection = { true },
          )
        coordinator.beginSession(RealtimeAgentSession(if (native) null else "relay", key))
        coordinator.beginConversationObservation(owner)
        assertTrue(coordinator.confirmConversationObservation(owner, key))
        repeat(128) { index ->
          coordinator.handleAgentEvent(
            Json
              .parseToJsonElement(
                """{"runId":"observed-$index","sessionKey":"$key","agentId":"scout","seq":1,"stream":"thinking","data":{}}""",
              ).jsonObject,
          )
        }
        assertEquals(TalkAgentActivity.Thinking, coordinator.activity.value?.activity)
        if (native) {
          val pending = coordinator.beginChatSend()
          assertTrue("Observed-only runs must not consume native input capacity", pending != null)
          coordinator.finishChatSend(pending, "real-input", "scout")
          assertFalse("Native final must reach the existing native TTS owner", coordinator.complete(key, "real-input", "native result"))
          assertTrue(calls.isEmpty())
        } else {
          assertTrue(coordinator.consult("real-call"))
          runCurrent()
          assertEquals(1, calls.count { it.method == "talk.client.toolCall" })
          assertTrue("Admission must not send a capacity error", calls.none { it.method == "talk.session.submitToolResult" })
          assertTrue(coordinator.complete(key, "real-input", "relay result"))
          runCurrent()
          val result = calls.single { it.method == "talk.session.submitToolResult" }
          val params = Json.parseToJsonElement(result.params).jsonObject
          assertEquals("real-call", params.getValue("callId").jsonPrimitive.content)
          assertEquals(
            "relay result",
            params
              .getValue("result")
              .jsonObject
              .getValue("text")
              .jsonPrimitive.content,
          )
        }
        coordinator.endSession()
      }
    }

  @Test
  fun authoritativeIdleMayOmitRunIdsButMissingSnapshotRemainsIncomplete() =
    runTest {
      val coordinator = coordinator(responses = { "{}" })
      val owner = observedOwner()
      coordinator.beginConversationObservation(owner)
      assertTrue(coordinator.confirmConversationObservation(owner, owner.owner.sessionKey))
      val revision = checkNotNull(coordinator.observationRevision(owner))
      coordinator.applyConversationSnapshot(owner, revision, Json.parseToJsonElement("""{"status":"unavailable"}""").jsonObject)
      assertEquals(TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      coordinator.applyConversationSnapshot(owner, revision, Json.parseToJsonElement("""{"sessionInfo":{"key":"agent:scout:call","agentId":"foreign","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
      assertEquals("Explicit foreign agent must not establish idle", TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      coordinator.applyConversationSnapshot(
        owner,
        revision,
        Json
          .parseToJsonElement(
            """{"sessionInfo":{"key":"agent:scout:call","agentId":"scout","hasActiveRun":false}}""",
          ).jsonObject,
      )
      assertEquals(null, coordinator.activity.value)
      coordinator.endSession()
    }

  @Test
  fun nativeFinalInvalidatesOlderActiveSnapshotBeforeRunRemoval() =
    runTest {
      val coordinator = coordinator(responses = { "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession(null, key))
      coordinator.beginConversationObservation(owner)
      assertTrue(coordinator.confirmConversationObservation(owner, key))
      val pending = coordinator.beginChatSend()
      assertTrue(pending != null)
      coordinator.finishChatSend(pending, "native-final", "scout")
      val revision = checkNotNull(coordinator.observationRevision(owner))
      assertFalse(coordinator.handleChatEvent(key, "native-final", "final", null, "scout", 2))
      assertTrue(checkNotNull(coordinator.observationRevision(owner)) > revision)
      coordinator.applyConversationSnapshot(
        owner,
        revision,
        Json
          .parseToJsonElement(
            """{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":true,"activeRunIds":["native-final"]}}""",
          ).jsonObject,
      )
      // A resurrected Unknown run would take precedence over the new live tool activity.
      coordinator.handleAgentEvent(
        Json
          .parseToJsonElement(
            """{"runId":"new-work","sessionKey":"$key","agentId":"scout","seq":1,"stream":"tool","data":{"phase":"start","toolCallId":"write","name":"write"}}""",
          ).jsonObject,
      )
      assertEquals(TalkAgentActivity.Writing, coordinator.activity.value?.activity)
      coordinator.endSession()
    }

  @Test
  fun completedErrorDoesNotMaskLaterRunOrReturnAfterItsSuccessfulFinal() =
    runTest {
      val coordinator = coordinator(responses = { "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginConversationObservation(owner)
      assertTrue(coordinator.confirmConversationObservation(owner, key))
      coordinator.applyConversationSnapshot(
        owner,
        checkNotNull(coordinator.observationRevision(owner)),
        Json
          .parseToJsonElement(
            """{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false}}""",
          ).jsonObject,
      )
      assertTrue(coordinator.handleChatEvent(key, "old-error", "error", null, "scout", 1))
      assertEquals(TalkAgentActivity.Error, coordinator.activity.value?.activity)
      coordinator.handleAgentEvent(
        Json
          .parseToJsonElement(
            """{"runId":"next-run","sessionKey":"$key","agentId":"scout","seq":1,"stream":"tool","data":{"phase":"start","toolCallId":"read","name":"read"}}""",
          ).jsonObject,
      )
      assertEquals(TalkAgentActivity.Reading, coordinator.activity.value?.activity)
      assertTrue(coordinator.handleChatEvent(key, "next-run", "final", null, "scout", 2))
      assertEquals(null, coordinator.activity.value)
      coordinator.endSession()
    }

  @Test
  fun p2ExplicitSnapshotReconcilesOnlyObserverRecords() =
    runTest {
      val coordinator = coordinator(responses = { "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession(null, key))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      val pending = checkNotNull(coordinator.beginChatSend())
      coordinator.finishChatSend(pending, "native-writer", "scout")
      coordinator.handleAgentEvent(p2Tool("lost-run", key))
      for (ids in listOf("", ",\"activeRunIds\":null")) {
        coordinator.applyConversationSnapshot(
          owner,
          checkNotNull(coordinator.observationRevision(owner)),
          Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":true$ids}}""").jsonObject,
        )
        assertEquals("Omitted/null run IDs are not an empty authoritative set", TalkAgentActivity.Reading, coordinator.activity.value?.activity)
      }
      coordinator.markObservationIncomplete(owner, clearTransient = true)
      coordinator.applyConversationSnapshot(
        owner,
        checkNotNull(coordinator.observationRevision(owner)),
        Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":true,"activeRunIds":["new-run"]}}""").jsonObject,
      )
      coordinator.handleAgentEvent(p2Tool("new-run", key, name = "write"))
      assertEquals("Absent lost observer must not mask the current run", TalkAgentActivity.Writing, coordinator.activity.value?.activity)
      assertFalse("Snapshot cannot discard native completion ownership", coordinator.handleChatEvent(key, "native-writer", "final", null, "scout", 2))
      coordinator.handleChatEvent(key, "new-run", "final", null, "scout", 2)
      coordinator.applyConversationSnapshot(
        owner,
        checkNotNull(coordinator.observationRevision(owner)),
        Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject,
      )
      assertEquals(null, coordinator.activity.value)
      coordinator.endSession()
    }

  @Test
  fun p2SnapshotPreservesPendingApprovalQuestionAndYieldedWait() =
    runTest {
      for (kind in listOf("approval", "question", "yielded")) {
        val coordinator = coordinator(responses = { "{}" })
        val owner = observedOwner()
        val key = owner.owner.sessionKey
        coordinator.beginConversationObservation(owner)
        coordinator.confirmConversationObservation(owner, key)
        coordinator.handleAgentEvent(p2Tool("waiting-run", key))
        val expected =
          when (kind) {
            "approval" -> {
              coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"waiting-run","sessionKey":"$key","agentId":"scout","seq":2,"stream":"lifecycle","data":{"phase":"waiting-approval","approvalId":"approval-fixture"}}""").jsonObject)
              TalkAgentActivity.WaitingForApproval
            }

            "question" -> {
              coordinator.handleQuestionEvent("question.requested", Json.parseToJsonElement("""{"id":"question-fixture","runId":"waiting-run","sessionKey":"$key","agentId":"scout","status":"pending","expiresAtMs":${System.currentTimeMillis() + 60000}}""").jsonObject)
              TalkAgentActivity.WaitingForInput
            }

            else -> {
              coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"waiting-run","sessionKey":"$key","agentId":"scout","seq":2,"stream":"lifecycle","data":{"phase":"end","yielded":true,"livenessState":"paused","stopReason":"end_turn"}}""").jsonObject)
              TalkAgentActivity.Waiting
            }
          }
        coordinator.applyConversationSnapshot(
          owner,
          checkNotNull(coordinator.observationRevision(owner)),
          Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject,
        )
        assertEquals("Snapshot is not resolution of $kind", expected, coordinator.activity.value?.activity)
        if (kind == "question") {
          coordinator.handleQuestionEvent("question.resolved", Json.parseToJsonElement("""{"id":"question-fixture","status":"answered"}""").jsonObject)
          assertEquals("Resolved obligation must not revive an inactive run", null, coordinator.activity.value)
          coordinator.handleQuestionEvent("question.requested", Json.parseToJsonElement("""{"id":"later-question","runId":"waiting-run","sessionKey":"$key","agentId":"scout","status":"pending","expiresAtMs":${System.currentTimeMillis() + 60000}}""").jsonObject)
          assertEquals("A later pending question is independent of run liveness", TalkAgentActivity.WaitingForInput, coordinator.activity.value?.activity)
          coordinator.handleQuestionEvent("question.resolved", Json.parseToJsonElement("""{"id":"later-question","status":"answered"}""").jsonObject)
          assertEquals(null, coordinator.activity.value)
        }
        coordinator.endSession()
      }
    }

  @Test
  fun p2AckWithoutOptionalIdentityPreservesPreAckTool() = verifyP2Ack(approval = false)

  @Test
  fun p2AckWithoutOptionalIdentityPreservesPreAckApproval() = verifyP2Ack(approval = true)

  private fun verifyP2Ack(approval: Boolean) =
    runTest {
      for ((includeTarget, includeAgent) in listOf(false to false, true to false, false to true, true to true)) {
        val ack = CompletableDeferred<String>()
        val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" })
        val owner = observedOwner()
        val key = owner.owner.sessionKey
        coordinator.beginSession(RealtimeAgentSession("relay", "agent:scout:relay"))
        coordinator.beginConversationObservation(owner)
        coordinator.confirmConversationObservation(owner, key)
        coordinator.consult("own-call")
        runCurrent()
        coordinator.handleAgentEvent(p2Tool("own-run", key))
        if (approval) coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"own-run","sessionKey":"$key","agentId":"scout","seq":2,"stream":"lifecycle","data":{"phase":"waiting-approval","approvalId":"approve"}}""").jsonObject)
        val target = if (includeTarget) ",\"agentSessionKey\":\"$key\"" else ""
        val agent = if (includeAgent) ",\"agentId\":\"scout\"" else ""
        ack.complete("""{"runId":"own-run"$target$agent}""")
        runCurrent()
        assertEquals("ACK must preserve observed identity (target=$includeTarget)", if (approval) TalkAgentActivity.WaitingForApproval else TalkAgentActivity.Reading, coordinator.activity.value?.activity)
        coordinator.handleChatEvent(key, "own-run", "final", Json.parseToJsonElement("""{"role":"assistant","content":"owned result"}"""), "scout", 3)
        runCurrent()
        assertEquals(1, calls.count { it.method == "talk.session.submitToolResult" })
        coordinator.endSession()
      }
    }

  @Test
  fun p2AckCanonicalIdentityPrecedesEarlyFinalLookup() =
    runTest {
      val ack = CompletableDeferred<String>()
      val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession("relay", "agent:scout:relay"))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.consult("early-call")
      runCurrent()
      coordinator.handleAgentEvent(p2Tool("early-owned", key))
      coordinator.handleChatEvent(key, "early-owned", "final", Json.parseToJsonElement("""{"role":"assistant","content":"early result"}"""), "scout", 2)
      ack.complete("""{"runId":"early-owned"}""")
      runCurrent()
      val results = calls.filter { it.method == "talk.session.submitToolResult" }
      assertEquals("Canonical observed key must be resolved before early-completion lookup", 1, results.size)
      assertTrue(results.single().params.contains("early result"))
      coordinator.endSession()
    }

  @Test
  fun p2ExplicitAckMismatchCannotReplaceObservedOwner() =
    runTest {
      val ack = CompletableDeferred<String>()
      val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession("relay", key))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.consult("bad-call")
      runCurrent()
      coordinator.handleAgentEvent(p2Tool("same-id", key))
      ack.complete("""{"runId":"same-id","agentId":"foreign","agentSessionKey":"agent:foreign:other"}""")
      runCurrent()
      assertEquals("Explicit mismatch cannot steal observed activity", TalkAgentActivity.Reading, coordinator.activity.value?.activity)
      assertTrue(calls.single { it.method == "talk.session.submitToolResult" }.params.contains("error"))
      coordinator.endSession()
    }

  @Test
  fun p2AckFirstCompletionRetainsPendingConversationQuestion() =
    runTest {
      for (native in listOf(false, true)) {
        val owner = observedOwner()
        val key = owner.owner.sessionKey
        val coordinator = coordinator(responses = { """{"runId":"ack-first","agentId":"scout","agentSessionKey":"$key"}""" })
        coordinator.beginSession(RealtimeAgentSession(if (native) null else "relay", key))
        coordinator.beginConversationObservation(owner)
        coordinator.confirmConversationObservation(owner, key)
        if (native) {
          coordinator.finishChatSend(coordinator.beginChatSend(), "ack-first", "scout")
        } else {
          coordinator.consult("ack-first-call")
          runCurrent()
        }
        coordinator.handleQuestionEvent("question.requested", Json.parseToJsonElement("""{"id":"ack-first-question","runId":"ack-first","sessionKey":"$key","agentId":"scout","status":"pending","expiresAtMs":${System.currentTimeMillis() + 60000}}""").jsonObject)
        assertEquals(TalkAgentActivity.WaitingForInput, coordinator.activity.value?.activity)
        coordinator.handleChatEvent(key, "ack-first", "final", Json.parseToJsonElement("""{"role":"assistant","content":"Waiting for input"}"""), "scout", 2, yielded = true)
        runCurrent()
        assertEquals("Completing the writer does not resolve its question (native=$native)", TalkAgentActivity.WaitingForInput, coordinator.activity.value?.activity)
        coordinator.handleQuestionEvent("question.resolved", Json.parseToJsonElement("""{"id":"ack-first-question","status":"answered"}""").jsonObject)
        assertEquals(TalkAgentActivity.Waiting, coordinator.activity.value?.activity)
        assertEquals(if (native) 0 else 1, calls.count { it.method == "talk.session.submitToolResult" })
        coordinator.endSession()
      }
    }

  @Test
  fun p2SequenceGapAndInactiveSnapshotDoNotResolveApproval() =
    runTest {
      val coordinator = coordinator(responses = { "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"approval-run","sessionKey":"$key","agentId":"scout","seq":1,"stream":"lifecycle","data":{"phase":"waiting-approval","approvalId":"still-pending"}}""").jsonObject)
      coordinator.markObservationIncomplete(owner, clearTransient = true)
      coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
      assertEquals("Run liveness is not approval resolution", TalkAgentActivity.WaitingForApproval, coordinator.activity.value?.activity)
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"approval-run","sessionKey":"$key","agentId":"scout","seq":2,"stream":"lifecycle","data":{"phase":"approval-resolved","approvalId":"still-pending"}}""").jsonObject)
      assertEquals(null, coordinator.activity.value)
      coordinator.endSession()
    }

  @Test
  fun p2YieldedFinalDoesNotResolveApproval() =
    runTest {
      val coordinator = coordinator(responses = { "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"paused-approval","sessionKey":"$key","agentId":"scout","seq":1,"stream":"lifecycle","data":{"phase":"waiting-approval","approvalId":"pending-approval"}}""").jsonObject)
      coordinator.handleChatEvent(key, "paused-approval", "final", null, "scout", 2, yielded = true)
      assertEquals(TalkAgentActivity.WaitingForApproval, coordinator.activity.value?.activity)
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"paused-approval","sessionKey":"$key","agentId":"scout","seq":3,"stream":"lifecycle","data":{"phase":"approval-resolved","approvalId":"pending-approval"}}""").jsonObject)
      assertEquals(TalkAgentActivity.Waiting, coordinator.activity.value?.activity)
      coordinator.endSession()
    }

  @Test
  fun p2AckFirstMissingTargetCanBindLaterCanonicalEvents() =
    runTest {
      for (explicitTarget in listOf(false, true)) {
        val owner = observedOwner()
        val key = owner.owner.sessionKey
        val alias = "agent:scout:voice-alias"
        val target = if (explicitTarget) ",\"agentSessionKey\":\"$alias\"" else ""
        val coordinator = coordinator(responses = { """{"runId":"ack-alias"$target}""" })
        coordinator.beginSession(RealtimeAgentSession("relay", alias))
        coordinator.beginConversationObservation(owner)
        coordinator.confirmConversationObservation(owner, key)
        coordinator.consult("alias-call")
        runCurrent()
        coordinator.handleAgentEvent(p2Tool("ack-alias", key))
        assertEquals(if (explicitTarget) TalkAgentActivity.Thinking else TalkAgentActivity.Reading, coordinator.activity.value?.activity)
        coordinator.handleChatEvent(key, "ack-alias", "final", Json.parseToJsonElement("""{"role":"assistant","content":"canonical result"}"""), "scout", 2)
        runCurrent()
        if (explicitTarget) {
          assertTrue("An explicit target must not be overwritten by observation", calls.none { it.method == "talk.session.submitToolResult" })
          coordinator.complete(alias, "ack-alias", "explicit result")
          runCurrent()
        }
        assertEquals(1, calls.count { it.method == "talk.session.submitToolResult" })
        coordinator.endSession()
      }
    }

  @Test
  fun p2NativeRetirementKeepsUnresolvedQuestionUntilResolution() =
    runTest {
      val coordinator = coordinator(responses = { "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession(null, key))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.finishChatSend(coordinator.beginChatSend(), "native-question", "scout")
      coordinator.handleQuestionEvent("question.requested", Json.parseToJsonElement("""{"id":"native-question-id","runId":"native-question","sessionKey":"$key","status":"pending","expiresAtMs":${System.currentTimeMillis() + 60000}}""").jsonObject)
      assertEquals("Qualified key supports optional question agentId", TalkAgentActivity.WaitingForInput, coordinator.activity.value?.activity)
      coordinator.endChatRun("native-question")
      assertEquals("Retiring a timed-out writer must not resolve its question", TalkAgentActivity.WaitingForInput, coordinator.activity.value?.activity)
      coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
      assertEquals(TalkAgentActivity.WaitingForInput, coordinator.activity.value?.activity)
      coordinator.handleQuestionEvent("question.resolved", Json.parseToJsonElement("""{"id":"native-question-id","status":"answered"}""").jsonObject)
      assertEquals(null, coordinator.activity.value)
      coordinator.endSession()
    }

  @Test
  fun p2InactiveSnapshotCannotEraseEvictedApprovalUncertainty() =
    runTest {
      val coordinator = coordinator(responses = { "{}" }, maxCachedCompletions = 1)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession(null, key))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"evicted-wait","sessionKey":"$key","agentId":"scout","seq":1,"stream":"lifecycle","data":{"phase":"waiting-approval","approvalId":"evicted-approval"}}""").jsonObject)
      val pending = checkNotNull(coordinator.beginChatSend())
      coordinator.finishChatSend(pending, "real-input", "scout")
      coordinator.handleChatEvent(key, "real-input", "final", null, "scout", 1)
      coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
      assertEquals(TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      assertTrue("Inactive is not resolution of an evicted approval", coordinator.activity.value?.incomplete == true)
      coordinator.endSession()
    }

  @Test
  fun p2EarlyFinalKeepsCanonicalCorrelationAtObservationCapacity() =
    runTest {
      val ack = CompletableDeferred<String>()
      val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" }, maxCachedCompletions = 1)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession("relay", "agent:scout:voice-alias"))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.consult("bounded-call")
      runCurrent()
      coordinator.handleChatEvent(key, "bounded-run", "final", Json.parseToJsonElement("""{"role":"assistant","content":"bounded result"}"""), "scout", 1)
      ack.complete("""{"runId":"bounded-run"}""")
      runCurrent()
      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("bounded result"))
      coordinator.endSession()
    }

  @Test
  fun p2ForeignEarlyFinalCannotReachRelayOrUnhandledWriter() =
    runTest {
      for (observedFirst in listOf(false, true)) {
        val ack = CompletableDeferred<String>()
        val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
        val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" }, onUnhandledCompletion = unhandled::add)
        val owner = observedOwner()
        val key = owner.owner.sessionKey
        coordinator.beginSession(RealtimeAgentSession("relay", "agent:scout:voice-alias"))
        coordinator.beginConversationObservation(owner)
        coordinator.confirmConversationObservation(owner, key)
        coordinator.consult("protected-call")
        runCurrent()
        if (observedFirst) coordinator.handleAgentEvent(p2Tool("protected-run", key))
        coordinator.handleChatEvent(key, "protected-run", "final", Json.parseToJsonElement("""{"role":"assistant","content":"synthetic foreign output"}"""), "foreign", 2)
        ack.complete("""{"runId":"protected-run"}""")
        runCurrent()
        assertTrue("Foreign output must not satisfy the relay", calls.none { it.method == "talk.session.submitToolResult" })
        assertTrue("Rejected output must not escape through the unhandled callback", unhandled.isEmpty())
        coordinator.handleChatEvent(key, "protected-run", "final", Json.parseToJsonElement("""{"role":"assistant","content":"owned output"}"""), "scout", 3)
        runCurrent()
        val result = calls.single { it.method == "talk.session.submitToolResult" }
        assertTrue(result.params.contains("owned output"))
        assertFalse(result.params.contains("synthetic foreign output"))
        coordinator.endSession()
      }
    }

  @Test
  fun p2ReadmissionRetainsUnresolvedQuestionFromStore() =
    runTest {
      for (snapshot in listOf(false, true)) {
        val coordinator = coordinator(responses = { "{}" }, maxCachedCompletions = 1)
        val owner = observedOwner()
        val key = owner.owner.sessionKey
        coordinator.beginSession(RealtimeAgentSession(null, key))
        coordinator.beginConversationObservation(owner)
        coordinator.confirmConversationObservation(owner, key)
        coordinator.handleQuestionEvent("question.requested", Json.parseToJsonElement("""{"id":"retained-question","runId":"readmitted","sessionKey":"$key","agentId":"scout","status":"pending","expiresAtMs":${System.currentTimeMillis() + 60000}}""").jsonObject)
        val pending = checkNotNull(coordinator.beginChatSend())
        coordinator.finishChatSend(pending, null, null)
        assertEquals(TalkAgentActivity.WaitingForInput, coordinator.activity.value?.activity)
        if (snapshot) {
          coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":true,"activeRunIds":["readmitted"]}}""").jsonObject)
        } else {
          coordinator.handleAgentEvent(p2Tool("readmitted", key))
        }
        assertEquals("Re-admission cannot hide a pending question", TalkAgentActivity.WaitingForInput, coordinator.activity.value?.activity)
        coordinator.endSession()
      }
    }

  @Test
  fun p2StaleYieldedFinalDispatchesWithoutReplacingNewerToolActivity() =
    runTest {
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      val coordinator = coordinator(responses = { """{"runId":"ordered-run","agentId":"scout","agentSessionKey":"$key"}""" })
      coordinator.beginSession(RealtimeAgentSession("relay", key))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.consult("ordered-call")
      runCurrent()
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"ordered-run","sessionKey":"$key","agentId":"scout","seq":10,"stream":"tool","data":{"phase":"start","toolCallId":"new-tool","name":"read"}}""").jsonObject)
      coordinator.handleChatEvent(key, "ordered-run", "final", Json.parseToJsonElement("""{"role":"assistant","content":"earlier yield"}"""), "scout", 9, yielded = true)
      runCurrent()
      assertEquals(TalkAgentActivity.Reading, coordinator.activity.value?.activity)
      assertEquals(1, calls.count { it.method == "talk.session.submitToolResult" })
      coordinator.endSession()
    }

  @Test
  fun p2ForeignFrameCannotDisplaceOwnedFinalBeforeAck() =
    runTest {
      val ack = CompletableDeferred<String>()
      val unhandled = mutableListOf<RealtimeAgentUnhandledCompletion>()
      val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" }, onUnhandledCompletion = unhandled::add)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession("relay", "agent:scout:voice-alias"))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.consult("ordered-identity-call")
      runCurrent()
      coordinator.handleChatEvent(key, "same-final", "final", Json.parseToJsonElement("""{"role":"assistant","content":"foreign frame"}"""), "foreign", 1)
      coordinator.handleChatEvent(key, "same-final", "final", Json.parseToJsonElement("""{"role":"assistant","content":"owned frame"}"""), "scout", 2)
      ack.complete("""{"runId":"same-final"}""")
      runCurrent()
      val result = calls.single { it.method == "talk.session.submitToolResult" }
      assertTrue(result.params.contains("owned frame"))
      assertFalse(result.params.contains("foreign frame"))
      assertTrue(unhandled.isEmpty())
      coordinator.endSession()
    }

  @Test
  fun p2RejectedObservationCannotLosePendingObligationUncertainty() =
    runTest {
      for (data in listOf(
        """"stream":"lifecycle","data":{"phase":"waiting-approval","approvalId":"dropped"}""",
        """"stream":"approval","data":{"phase":"requested","status":"pending","approvalId":"dropped"}""",
        """"stream":"lifecycle","data":{"phase":"end","yielded":true,"livenessState":"paused","stopReason":"end_turn"}""",
      )) {
        val coordinator = coordinator(responses = { "{}" }, maxCachedCompletions = 1)
        val owner = observedOwner()
        val key = owner.owner.sessionKey
        coordinator.beginConversationObservation(owner)
        coordinator.confirmConversationObservation(owner, key)
        coordinator.handleAgentEvent(p2Tool("retained-run", key))
        coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"dropped-run","sessionKey":"$key","agentId":"scout","seq":1,$data}""").jsonObject)
        coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
        assertEquals(TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
        assertTrue("Inactive liveness cannot resolve a dropped obligation", coordinator.activity.value?.incomplete == true)
        coordinator.endSession()
      }
    }

  @Test
  fun p2AckPruningKeepsUnrepresentedObligationUncertainty() =
    runTest {
      for (native in listOf(false, true)) {
        val ack = CompletableDeferred<String>()
        val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" }, maxCachedCompletions = 1)
        val owner = observedOwner()
        val key = owner.owner.sessionKey
        coordinator.beginSession(RealtimeAgentSession(if (native) null else "relay", key))
        coordinator.beginConversationObservation(owner)
        coordinator.confirmConversationObservation(owner, key)
        val pending = if (native) coordinator.beginChatSend() else null
        if (!native) {
          coordinator.consult("writer-call")
          runCurrent()
        }
        coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"other-wait","sessionKey":"$key","agentId":"scout","seq":1,"stream":"lifecycle","data":{"phase":"waiting-approval","approvalId":"unrepresented"}}""").jsonObject)
        if (native) {
          coordinator.finishChatSend(checkNotNull(pending), "writer", "scout")
        } else {
          ack.complete("""{"runId":"writer","agentSessionKey":"$key","agentId":"scout"}""")
          runCurrent()
        }
        coordinator.handleChatEvent(key, "writer", "final", null, "scout", 2)
        runCurrent()
        coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
        assertEquals("ACK pruning cannot resolve an unrelated approval", TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
        coordinator.endSession()
      }
    }

  @Test
  fun p2UnadmittedYieldedFinalKeepsObligationUncertainty() =
    runTest {
      val coordinator = coordinator(responses = { "{}" }, maxCachedCompletions = 1)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.handleAgentEvent(p2Tool("full-record", key))
      coordinator.handleChatEvent(key, "unrepresented-yield", "final", null, "scout", 1, yielded = true)
      coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
      assertEquals(TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      coordinator.endSession()
    }

  @Test
  fun p2QuestionStoreOverflowKeepsObligationUncertainty() =
    runTest {
      val coordinator = coordinator(responses = { "{}" }, maxCachedCompletions = 1)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      for (id in listOf("retained", "discarded")) {
        coordinator.handleQuestionEvent("question.requested", Json.parseToJsonElement("""{"id":"$id","runId":"$id-run","sessionKey":"$key","agentId":"scout","status":"pending","expiresAtMs":${System.currentTimeMillis() + 60000}}""").jsonObject)
      }
      coordinator.handleQuestionEvent("question.resolved", Json.parseToJsonElement("""{"id":"retained","status":"answered"}""").jsonObject)
      coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
      assertEquals(TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      coordinator.endSession()
    }

  @Test
  fun r6TimeoutPruningPreservesBufferedApproval() =
    runTest(timeout = 5.seconds) {
      val coordinator =
        coordinator(responses = { method ->
          if (method == "talk.client.toolCall") withTimeout(100) { kotlinx.coroutines.awaitCancellation() } else "{}"
        }, maxCachedCompletions = 1)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession("relay", key))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.consult("timeout-call")
      runCurrent()
      coordinator.handleAgentEvent(r6Approval(key, "waiting", 1, "pending"))
      advanceTimeBy(101)
      runCurrent()
      assertTrue(calls.single { it.method == "talk.session.submitToolResult" }.params.contains("timed out"))
      r6Inactive(coordinator, owner)
      assertEquals("Timeout does not resolve a buffered approval", TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      coordinator.endSession()
    }

  @Test
  fun r6HigherSequenceDoesNotProveBufferedApprovalApplied() =
    runTest(timeout = 5.seconds) {
      val ack = CompletableDeferred<String>()
      val coordinator = coordinator(responses = { if (it == "talk.client.toolCall") ack.await() else "{}" }, maxCachedCompletions = 2)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession("relay", key))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      coordinator.handleAgentEvent(p2Tool("occupant", key))
      coordinator.consult("other-call")
      runCurrent()
      coordinator.handleAgentEvent(r6Approval(key, "delayed", 1, "pending"))
      coordinator.handleChatEvent(key, "occupant", "final", null, "scout", 2)
      coordinator.handleAgentEvent(Json.parseToJsonElement("""{"runId":"delayed","sessionKey":"$key","agentId":"scout","seq":2,"stream":"tool","data":{"phase":"start","toolCallId":"later-tool","name":"read"}}""").jsonObject)
      ack.complete("""{"runId":"writer","agentSessionKey":"$key","agentId":"scout"}""")
      runCurrent()
      coordinator.handleChatEvent(key, "writer", "final", null, "scout", 3)
      r6Inactive(coordinator, owner)
      assertEquals("A newer unrelated event never applies an older approval", TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      coordinator.endSession()
    }

  @Test
  fun r6PreconfirmationEvictionRetainsObligationLoss() =
    runTest(timeout = 5.seconds) {
      val coordinator = coordinator(responses = { "{}" }, maxCachedCompletions = 1)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginConversationObservation(owner)
      coordinator.handleAgentEvent(r6Approval(key, "early", 1, "pending"))
      coordinator.handleAgentEvent(p2Tool("replacement", key))
      coordinator.confirmConversationObservation(owner, key)
      r6Inactive(coordinator, owner)
      assertEquals("Confirmation cannot recover an evicted approval", TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      coordinator.endSession()
    }

  @Test
  fun r6ApprovalOverflowRetainsIndependentObligationLoss() =
    runTest(timeout = 5.seconds) {
      val coordinator = coordinator(responses = { "{}" })
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      for (id in 1..65) coordinator.handleAgentEvent(r6Approval(key, "many", id.toLong(), "pending", "approval-$id"))
      r6Inactive(coordinator, owner)
      for (id in 1..64) coordinator.handleAgentEvent(r6Approval(key, "many", 100L + id, "resolved", "approval-$id"))
      assertEquals("Resolving retained entries cannot resolve the dropped 65th approval", TalkAgentActivity.Unknown, coordinator.activity.value?.activity)
      coordinator.endSession()
    }

  @Test
  fun r6AppliedBufferedApprovalDoesNotManufactureLoss() =
    runTest(timeout = 5.seconds) {
      val coordinator = coordinator(responses = { "{}" }, maxCachedCompletions = 1)
      val owner = observedOwner()
      val key = owner.owner.sessionKey
      coordinator.beginSession(RealtimeAgentSession(null, key))
      coordinator.beginConversationObservation(owner)
      coordinator.confirmConversationObservation(owner, key)
      val pending = checkNotNull(coordinator.beginChatSend())
      coordinator.handleAgentEvent(r6Approval(key, "ack-run", 1, "pending"))
      coordinator.finishChatSend(pending, "ack-run", "scout")
      assertEquals(TalkAgentActivity.WaitingForApproval, coordinator.activity.value?.activity)
      coordinator.handleAgentEvent(r6Approval(key, "ack-run", 2, "resolved"))
      coordinator.handleChatEvent(key, "ack-run", "final", null, "scout", 3)
      r6Inactive(coordinator, owner)
      assertEquals(null, coordinator.activity.value)
      coordinator.endSession()
    }

  private fun r6Approval(
    key: String,
    run: String,
    seq: Long,
    status: String,
    id: String = "approval",
  ) = Json.parseToJsonElement("""{"runId":"$run","sessionKey":"$key","agentId":"scout","seq":$seq,"stream":"approval","data":{"phase":"${if (status == "pending") "requested" else "resolved"}","status":"$status","approvalId":"$id"}}""").jsonObject

  private fun r6Inactive(
    coordinator: RealtimeAgentCoordinator,
    owner: TalkModeManager.ChatStart,
  ) {
    val key = owner.owner.sessionKey
    coordinator.applyConversationSnapshot(owner, checkNotNull(coordinator.observationRevision(owner)), Json.parseToJsonElement("""{"sessionInfo":{"key":"$key","agentId":"scout","hasActiveRun":false,"activeRunIds":[]}}""").jsonObject)
  }

  private fun p2Tool(
    runId: String,
    key: String,
    name: String = "read",
  ) = Json
    .parseToJsonElement(
      """{"runId":"$runId","sessionKey":"$key","agentId":"scout","seq":1,"stream":"tool","data":{"phase":"start","toolCallId":"tool-fixture","name":"$name"}}""",
    ).jsonObject

  private fun observedOwner() =
    TalkModeManager.ChatStart(
      ChatComposerOwner("observation-fixture", "scout", "agent:scout:call"),
      GatewaySession.RequestLease("observation-fixture") { _, _, _, enqueue ->
        enqueue {}
        "{}"
      },
      withCurrentSelection = { it() },
      isCurrentSelection = { true },
    )

  private fun kotlinx.coroutines.test.TestScope.coordinator(
    responses: suspend (String) -> String,
    onWorking: (RealtimeAgentSession) -> Unit = {},
    onError: (String) -> Unit = {},
    onUnhandledCompletion: (RealtimeAgentUnhandledCompletion) -> Unit = {},
    maxCachedCompletions: Int = 128,
  ): RealtimeAgentCoordinator {
    calls = mutableListOf()
    return RealtimeAgentCoordinator(
      parentScope = backgroundScope,
      requestGateway = { method, params, timeoutMs ->
        calls += GatewayCall(method, params.orEmpty(), timeoutMs)
        responses(method)
      },
      onWorking = onWorking,
      onError = { _, message -> onError(message) },
      onUnhandledCompletion = onUnhandledCompletion,
      maxCachedCompletions = maxCachedCompletions,
    )
  }

  private fun RealtimeAgentCoordinator.consult(
    callId: String,
    forced: Boolean = false,
  ): Boolean = handleToolCall(callId, "openclaw_agent_consult", null, forced)

  private fun RealtimeAgentCoordinator.complete(
    sessionKey: String?,
    runId: String,
    text: String,
  ): Boolean = handleChatEvent(sessionKey, runId, "final", Json.parseToJsonElement("""{"role":"assistant","content":"$text"}"""))

  private data class GatewayCall(
    val method: String,
    val params: String,
    val timeoutMs: Long,
  )
}

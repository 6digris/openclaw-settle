package ai.openclaw.app.ui.chat

import ai.openclaw.app.gateway.GatewayEndpoint
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import java.net.InetAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

internal data class TalkOwnershipRequest(
  val connection: Int,
  val method: String,
  val params: JsonObject,
)

internal class PendingTalkOwnershipCreate(
  val request: TalkOwnershipRequest,
  private val reply: () -> Unit,
) {
  private val replied = AtomicBoolean()

  fun complete() {
    if (replied.compareAndSet(false, true)) reply()
  }
}

/** Local wire fixture: create stays pending, so no provider or microphone audio is needed. */
internal class ChatRealtimeTalkGatewayFixture : AutoCloseable {
  private val server = MockWebServer()
  private val connectionSequence = AtomicInteger()
  private val operatorSockets = CopyOnWriteArrayList<WebSocket>()
  val requests = CopyOnWriteArrayList<TalkOwnershipRequest>()
  val creates = CopyOnWriteArrayList<PendingTalkOwnershipCreate>()
  val endpoint: GatewayEndpoint

  @Volatile var nativeTalk = false

  @Volatile var nativeAssistantReply = "Synthetic native spoken reply"
  private val history = java.util.concurrent.ConcurrentHashMap<String, String>()

  init {
    server.dispatcher =
      object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse =
          if (request.getHeader("Upgrade").equals("websocket", ignoreCase = true)) {
            MockResponse().withWebSocketUpgrade(listener(connectionSequence.incrementAndGet()))
          } else {
            MockResponse().setResponseCode(404)
          }
      }
    server.start(InetAddress.getByName("127.0.0.1"), 0)
    endpoint = GatewayEndpoint.manual("127.0.0.1", server.port)
  }

  private fun listener(connection: Int) =
    object : WebSocketListener() {
      override fun onOpen(
        webSocket: WebSocket,
        response: Response,
      ) {
        webSocket.send("""{"type":"event","event":"connect.challenge","payload":{"nonce":"talk-ownership-fixture","ts":1700000000123}}""")
      }

      override fun onMessage(
        webSocket: WebSocket,
        text: String,
      ) {
        val frame = Json.parseToJsonElement(text).jsonObject
        if (frame["type"]?.jsonPrimitive?.content != "req") return
        val id = frame.getValue("id")
        val method = frame.getValue("method").jsonPrimitive.content
        val params = frame["params"] as? JsonObject ?: JsonObject(emptyMap())
        val request = TalkOwnershipRequest(connection, method, params)
        requests += request

        fun respond(payload: String) {
          webSocket.send(
            buildJsonObject {
              put("type", JsonPrimitive("res"))
              put("id", id)
              put("ok", JsonPrimitive(true))
              put("payload", Json.parseToJsonElement(payload))
            }.toString(),
          )
        }

        when (method) {
          "connect" -> {
            val role = params.getValue("role").jsonPrimitive.content
            if (role == "operator") operatorSockets.add(webSocket)
            val scopes = if (role == "operator") "[\"operator.admin\"]" else "[]"
            respond(
              """{"type":"hello-ok","protocol":3,"server":{"host":"talk-ownership","version":"fixture"},"features":{"methods":["chat.history","chat.metadata","sessions.describe","sessions.list","models.list","health","talk.config","talk.session.create","talk.session.close"],"events":[]},"auth":{"role":"$role","scopes":$scopes},"snapshot":{"sessionDefaults":{"mainSessionKey":"agent:scout:main"}}}""",
            )
          }

          "chat.history" -> {
            val key = params.getValue("sessionKey").jsonPrimitive.content
            respond("""{"sessionId":"transcript-$key","messages":${history[key] ?: "[]"}}""")
          }

          "sessions.describe" -> {
            respond("""{"session":{"label":"Existing Android chat"}}""")
          }

          "sessions.list" -> {
            respond("""{"sessions":[]}""")
          }

          "models.list" -> {
            respond("""{"models":[]}""")
          }

          "chat.metadata" -> {
            respond("""{"commands":[]}""")
          }

          "question.list" -> {
            respond("""{"questions":[]}""")
          }

          "health" -> {
            respond("""{"ok":true}""")
          }

          "sessions.subscribe", "sessions.messages.subscribe", "talk.session.close" -> {
            respond("{}")
          }

          "talk.config" -> {
            respond(
              if (nativeTalk) {
                """{"config":{"talk":{"realtime":{"model":"gpt-live"},"silenceTimeoutMs":800}}}"""
              } else {
                """{"config":{"talk":{"realtime":{"provider":"openai","mode":"realtime","transport":"gateway-relay","model":"gpt-realtime-2.1"}}}}"""
              },
            )
          }

          "chat.send" -> {
            if (nativeTalk) {
              val key = params.getValue("sessionKey").jsonPrimitive.content
              val spoken = JsonPrimitive(nativeAssistantReply).toString()
              history[key] = """[{"role":"assistant","content":[{"type":"thinking","text":"Private reasoning must not become speech"},{"type":"image","text":"Attachment metadata must not become speech"},{"type":"text","text":$spoken}]}]"""
              respond("""{"runId":"native-caption-turn","status":"ok"}""")
            } else {
              webSocket.send(
                buildJsonObject {
                  put("type", JsonPrimitive("res"))
                  put("id", id)
                  put("ok", JsonPrimitive(false))
                  put(
                    "error",
                    buildJsonObject {
                      put("code", JsonPrimitive("INVALID_REQUEST"))
                      put("message", JsonPrimitive("Talk ownership fixture does not implement $method"))
                    },
                  )
                }.toString(),
              )
            }
          }

          "talk.speak" -> {
            respond("""{"audioBase64":"AQIDBA==","provider":"synthetic","outputFormat":"pcm_24000"}""")
          }

          "talk.client.toolCall" -> {
            respond("""{"runId":"call-work","agentId":"scout","agentSessionKey":"${params.getValue("sessionKey").jsonPrimitive.content}"}""")
          }

          "talk.session.submitToolResult" -> {
            respond("{}")
          }

          "talk.session.create" -> {
            creates += PendingTalkOwnershipCreate(request) { respond("""{"relaySessionId":"ownership-relay"}""") }
          }

          else -> {
            webSocket.send(
              buildJsonObject {
                put("type", JsonPrimitive("res"))
                put("id", id)
                put("ok", JsonPrimitive(false))
                put(
                  "error",
                  buildJsonObject {
                    put("code", JsonPrimitive("INVALID_REQUEST"))
                    put("message", JsonPrimitive("Talk ownership fixture does not implement $method"))
                  },
                )
              }.toString(),
            )
          }
        }
      }
    }

  fun publishTranscriptHistory(
    sessionKey: String,
    messages: String,
  ) {
    history[sessionKey] = messages
    sendEvent("session.message", """{"sessionKey":"$sessionKey","agentId":"scout","phase":"message"}""")
  }

  fun sendEvent(
    event: String,
    payload: String,
  ) {
    val frame =
      buildJsonObject {
        put("type", JsonPrimitive("event"))
        put("event", JsonPrimitive(event))
        put("payload", Json.parseToJsonElement(payload))
      }.toString()
    operatorSockets.forEach { check(it.send(frame)) }
  }

  fun dropOperatorConnection() {
    operatorSockets.forEach { it.close(1011, "Synthetic connection loss") }
    operatorSockets.clear()
  }

  fun releaseCreates() {
    creates.forEach { it.complete() }
  }

  override fun close() {
    releaseCreates()
    server.shutdown()
  }
}

package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewayRequestNotEnqueued
import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

internal const val AGENT_SCOPED_SESSION_GROUPS_CAPABILITY = "sessions.groups.agent-scoped"
internal const val SESSION_GROUPS_UNSUPPORTED = "Update the Gateway to manage agent-owned groups. Chat and existing thread categories remain available."

/** A dialog retains both the logical owner and the physical connection that displayed it. */
internal class ChatSessionGroupRoute(
  val gatewayScope: ChatCacheScope,
  val agentId: String,
  internal val lease: GatewaySession.RequestLease,
)

@Serializable
internal data class LegacySessionGroupOwner(
  val gatewayId: String,
  val profileId: String,
  val agentId: String,
)

@Serializable
internal data class LegacySessionGroupImport(
  val owner: LegacySessionGroupOwner,
  val importId: String,
)

internal data class ChatSessionGroupCatalog(
  val gatewayId: String? = null,
  val agentId: String? = null,
  val names: List<String> = emptyList(),
  val sectionOrder: List<String>? = null,
  val error: String? = null,
)

/** Gateway-derived catalog only: no local mutation or per-member patch fallback. */
internal class ChatSessionGroups(
  private val json: Json,
  private val currentScope: () -> ChatCacheScope?,
  private val currentAgentId: () -> String?,
  private val defaultAgentId: () -> String?,
  private val supportsScopedGroups: () -> Boolean,
  private val captureLease: (ChatCacheScope) -> GatewaySession.RequestLease?,
  private val legacyNames: () -> List<String> = { emptyList() },
  private val acknowledgeLegacyNames: (List<String>) -> Unit = {},
  private val claimLegacyImport: suspend (LegacySessionGroupOwner) -> String? = { null },
  private val onMembersChanged: () -> Unit = {},
  private val cache: ChatTranscriptCache? = null,
) {
  private val lock = Any()
  private val mutations = Mutex()
  private val migration = Mutex()
  private val cacheWrites = Mutex()
  private val catalogs = mutableMapOf<Pair<String, String>, ChatSessionGroupCatalog>()
  private val revisions = mutableMapOf<Pair<ChatCacheScope, String>, Long>()
  private var revision = 0L
  private val mutableCatalog = MutableStateFlow(ChatSessionGroupCatalog())
  val catalog: StateFlow<ChatSessionGroupCatalog> = mutableCatalog.asStateFlow()

  fun select() {
    synchronized(lock) {
      revision += 1
      val scope = currentScope()
      revisions.keys.removeAll { it.first != scope }
      val gateway = scope?.gatewayId
      val agent = currentAgentId()
      mutableCatalog.value =
        if (gateway != null && agent != null) {
          catalogs[gateway to agent] ?: ChatSessionGroupCatalog(gateway, agent)
        } else {
          ChatSessionGroupCatalog(gateway, agent)
        }
    }
  }

  suspend fun clearGateway(gatewayId: String) {
    synchronized(lock) {
      catalogs.keys.removeAll { it.first == gatewayId }
      revisions.keys.removeAll { it.first.gatewayId == gatewayId }
      if (mutableCatalog.value.gatewayId == gatewayId) {
        revision += 1
        mutableCatalog.value = ChatSessionGroupCatalog()
      }
    }
    // Settle an admitted cache write before the existing Gateway purge deletes persisted rows.
    cacheWrites.withLock {}
  }

  fun capture(agentId: String?): ChatSessionGroupRoute? {
    val agent = agentId?.trim()?.takeIf { it.isNotEmpty() && it != "*" } ?: return null
    val scope = currentScope() ?: return null
    val lease =
      captureLease(scope) ?: run {
        synchronized(lock) {
          if (currentScope() == scope && currentAgentId() == agent) {
            mutableCatalog.value = mutableCatalog.value.copy(error = "Connect to the Gateway to manage groups.")
          }
        }
        return null
      }
    return ChatSessionGroupRoute(scope, agent, lease)
  }

  private fun isCurrent(route: ChatSessionGroupRoute): Boolean = currentScope() == route.gatewayScope && route.lease.isCurrent()

  fun routeIsCurrent(route: ChatSessionGroupRoute): Boolean = isCurrent(route)

  fun requireCurrent(route: ChatSessionGroupRoute) {
    if (!isCurrent(route)) throw GatewayRequestNotEnqueued("Gateway connection changed; reopen the group action.")
    check(supportsScopedGroups()) { SESSION_GROUPS_UNSUPPORTED }
  }

  private suspend fun request(
    route: ChatSessionGroupRoute,
    method: String,
    params: JsonObject,
  ): String {
    requireCurrent(route)
    return route.lease.request(method, params.toString(), withEnqueue = { enqueue ->
      requireCurrent(route)
      enqueue()
    })
  }

  private fun params(
    route: ChatSessionGroupRoute,
    entries: Map<String, JsonElement> = emptyMap(),
  ): JsonObject =
    buildJsonObject {
      put("agentId", JsonPrimitive(route.agentId))
      entries.forEach { (key, value) -> put(key, value) }
    }

  private fun decode(
    scope: ChatCacheScope,
    agentId: String,
    response: String,
  ): ChatSessionGroupCatalog {
    val root = json.parseToJsonElement(response) as? JsonObject ?: error("Invalid group catalog response")
    val groups = root["groups"] as? JsonArray ?: error("Invalid group catalog response")
    val names =
      groups.map { row ->
        ((row as? JsonObject)?.get("name") as? JsonPrimitive)?.content?.takeIf(String::isNotBlank)
          ?: error("Invalid group catalog entry")
      }
    val order =
      (root["sectionOrder"] as? JsonArray)?.map {
        (it as? JsonPrimitive)?.content ?: error("Invalid group section order")
      }
    return ChatSessionGroupCatalog(scope.gatewayId, agentId, names, order)
  }

  private fun publish(
    route: ChatSessionGroupRoute,
    value: ChatSessionGroupCatalog,
    requestRevision: Long,
  ) {
    route.lease.commitIfCurrent {
      synchronized(lock) {
        if (currentScope() != route.gatewayScope || revisions[route.gatewayScope to route.agentId] != requestRevision) return@synchronized
        catalogs[route.gatewayScope.gatewayId to route.agentId] = value
        if (currentAgentId() == route.agentId) mutableCatalog.value = value
      }
    }
  }

  private fun failure(
    route: ChatSessionGroupRoute,
    error: Throwable,
    requestRevision: Long,
  ) {
    route.lease.commitIfCurrent {
      synchronized(lock) {
        if (currentScope() == route.gatewayScope && currentAgentId() == route.agentId && revisions[route.gatewayScope to route.agentId] == requestRevision) {
          mutableCatalog.value = mutableCatalog.value.copy(error = error.message ?: "Unable to update groups.")
        }
      }
    }
  }

  suspend fun restoreOffline() {
    val scope = currentScope() ?: return
    val agent = currentAgentId() ?: return
    val requestRevision =
      synchronized(lock) {
        if (catalogs.containsKey(scope.gatewayId to agent)) return
        revisions.getOrPut(scope to agent) { ++revision }
      }
    val value =
      try {
        val response = cache?.loadSessionGroups(scope.gatewayId, agent) ?: return
        decode(scope, agent, response)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: Throwable) {
        // Disposable cache failure must not stop live chat or a fresh Gateway catalog read.
        return
      }
    synchronized(lock) {
      if (currentScope() != scope || revisions[scope to agent] != requestRevision || catalogs.containsKey(scope.gatewayId to agent)) return
      catalogs[scope.gatewayId to agent] = value
      if (currentAgentId() == agent) mutableCatalog.value = value
    }
  }

  private suspend fun save(
    route: ChatSessionGroupRoute,
    response: String,
    requestRevision: Long,
  ) {
    cacheWrites.withLock {
      if (!isCurrent(route) || synchronized(lock) { revisions[route.gatewayScope to route.agentId] != requestRevision }) return@withLock
      try {
        cache?.saveSessionGroups(route.gatewayScope.gatewayId, route.agentId, response)
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (_: Throwable) {
        // The Gateway already acknowledged the catalog; a disposable cache is not a second writer.
      }
    }
  }

  suspend fun refresh() {
    val route = capture(currentAgentId()) ?: return
    refresh(route)
  }

  suspend fun refresh(route: ChatSessionGroupRoute) {
    val requestRevision = synchronized(lock) { (++revision).also { revisions[route.gatewayScope to route.agentId] = it } }
    try {
      requireCurrent(route)
      val importError =
        try {
          importLegacy(route)
          null
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (error: Throwable) {
          // A pending legacy import never prevents browsing the canonical current-owner catalog.
          error.message ?: "Unable to import legacy groups."
        }
      val response = request(route, "sessions.groups.list", params(route))
      publish(route, decode(route.gatewayScope, route.agentId, response).copy(error = importError), requestRevision)
      save(route, response, requestRevision)
    } catch (cancelled: CancellationException) {
      throw cancelled
    } catch (error: Throwable) {
      failure(route, error, requestRevision)
    }
  }

  /** One global legacy list goes to the configured default, never every visited agent. */
  private suspend fun importLegacy(route: ChatSessionGroupRoute) {
    migration.withLock {
      val names = legacyNames()
      if (names.isEmpty()) return@withLock
      val owner = defaultAgentId()?.takeIf { it.isNotBlank() && it != "*" } ?: return@withLock
      val migrationRoute = ChatSessionGroupRoute(route.gatewayScope, owner, route.lease)
      // users.self identifies the authenticated profile on this same socket. A failed lookup is
      // not permission to import anonymously or retry through a global group method.
      val profile = json.parseToJsonElement(request(migrationRoute, "users.self", buildJsonObject {})) as? JsonObject
      val profileId = ((profile?.get("profile") as? JsonObject)?.get("id") as? JsonPrimitive)?.content
      if (profileId.isNullOrBlank()) return@withLock
      val importId =
        checkNotNull(claimLegacyImport(LegacySessionGroupOwner(route.gatewayScope.gatewayId, profileId, owner))) {
          "Legacy groups are waiting for their original Gateway, profile, and default agent."
        }
      if (defaultAgentId() != owner) return@withLock
      val response =
        request(
          migrationRoute,
          "sessions.groups.put",
          params(
            migrationRoute,
            mapOf(
              "names" to JsonArray(names.map(::JsonPrimitive)),
              "append" to JsonPrimitive(true),
              "importId" to JsonPrimitive(importId),
            ),
          ),
        )
      decode(migrationRoute.gatewayScope, migrationRoute.agentId, response)
      val acknowledgedProfile = json.parseToJsonElement(request(migrationRoute, "users.self", buildJsonObject {})) as? JsonObject
      val acknowledgedProfileId = ((acknowledgedProfile?.get("profile") as? JsonObject)?.get("id") as? JsonPrimitive)?.content
      if (acknowledgedProfileId != profileId) return@withLock
      route.lease.commitIfCurrent {
        // Socket identity also pins the profile; a reconnect, default-owner change, or credential
        // replacement leaves the source intact. The durable receipt ID consumes each name once,
        // so reconciliation after an uncertain ACK cannot resurrect a subsequently deleted group.
        if (currentScope() == route.gatewayScope && defaultAgentId() == owner) acknowledgeLegacyNames(names)
      }
    }
  }

  suspend fun create(
    route: ChatSessionGroupRoute,
    name: String,
  ): Boolean {
    val normalized = name.trim().takeIf(String::isNotEmpty) ?: return false
    return mutate(
      route,
      "sessions.groups.put",
      mapOf(
        "names" to JsonArray(listOf(JsonPrimitive(normalized))),
        "append" to JsonPrimitive(true),
      ),
      returnsCatalog = true,
    )
  }

  suspend fun rename(
    route: ChatSessionGroupRoute,
    from: String,
    to: String,
  ): Boolean = mutate(route, "sessions.groups.rename", mapOf("name" to JsonPrimitive(from.trim()), "to" to JsonPrimitive(to.trim())))

  suspend fun delete(
    route: ChatSessionGroupRoute,
    name: String,
  ): Boolean = mutate(route, "sessions.groups.delete", mapOf("name" to JsonPrimitive(name.trim())))

  private suspend fun mutate(
    route: ChatSessionGroupRoute,
    method: String,
    entries: Map<String, JsonElement>,
    returnsCatalog: Boolean = false,
  ): Boolean =
    mutations.withLock {
      var requestRevision = synchronized(lock) { (++revision).also { revisions[route.gatewayScope to route.agentId] = it } }
      try {
        val response = request(route, method, params(route, entries))
        // Retire reads started while the mutation was in flight before its canonical readback.
        requestRevision = synchronized(lock) { (++revision).also { revisions[route.gatewayScope to route.agentId] = it } }
        val catalogResponse = if (returnsCatalog) response else request(route, "sessions.groups.list", params(route))
        publish(route, decode(route.gatewayScope, route.agentId, catalogResponse), requestRevision)
        save(route, catalogResponse, requestRevision)
        if (isCurrent(route) && currentAgentId() == route.agentId) onMembersChanged()
        true
      } catch (cancelled: CancellationException) {
        throw cancelled
      } catch (error: Throwable) {
        failure(route, error, requestRevision)
        false
      }
    }

  fun changed(agentId: String?): Boolean {
    if (agentId == null) return false
    synchronized(lock) {
      currentScope()?.let { scope ->
        catalogs.remove(scope.gatewayId to agentId)
        revisions[scope to agentId] = ++revision
      }
    }
    return agentId == currentAgentId()
  }
}

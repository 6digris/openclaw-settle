package ai.openclaw.app.chat

import ai.openclaw.app.gateway.GatewaySession
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatSessionGroupsTest {
  private class Fixture(
    cache: ChatTranscriptCache? = null,
  ) {
    var scope = ChatCacheScope("gateway-a", 1L)
    var agent = "alpha"
    var defaultAgent = "configured-default"
    var supports = true
    var legacy = listOf<String>()
    var profile = "profile-a"
    var legacyOwner: LegacySessionGroupOwner? = null
    val importId = "android-legacy-import-id"
    val requests = mutableListOf<Pair<String, JsonObject>>()
    var response: suspend (String, JsonObject) -> String = { method, _ ->
      if (method == "users.self") """{"profile":{"id":"$profile"}}""" else catalog("Work")
    }
    val groups =
      ChatSessionGroups(
        json = Json,
        currentScope = { scope },
        currentAgentId = { agent },
        defaultAgentId = { defaultAgent },
        supportsScopedGroups = { supports },
        captureLease = { captured ->
          GatewaySession.RequestLease(
            endpointStableId = captured.gatewayId,
            isCurrentImpl = { captured == scope },
          ) { method, params, _, enqueue ->
            enqueue {}
            val payload = Json.parseToJsonElement(params!!).jsonObject
            requests += method to payload
            response(method, payload)
          }
        },
        legacyNames = { legacy },
        acknowledgeLegacyNames = { captured -> if (legacy == captured) legacy = emptyList() },
        claimLegacyImport = { owner ->
          if (legacyOwner == null) legacyOwner = owner
          importId.takeIf { legacyOwner == owner }
        },
        cache = cache,
      ).also { it.select() }
  }

  private class GroupCache : ChatTranscriptCache {
    var groups: String? = null
    var beforeRead: suspend () -> Unit = {}

    override suspend fun loadSessionGroups(
      gatewayId: String,
      agentId: String,
    ): String? {
      val captured = groups
      beforeRead()
      return captured
    }

    override suspend fun saveSessionGroups(
      gatewayId: String,
      agentId: String,
      catalogJson: String,
    ) {
      groups = catalogJson
    }

    override suspend fun loadLastDefaultAgentId(gatewayId: String): String? = null

    override suspend fun saveLastDefaultAgentId(
      gatewayId: String,
      agentId: String,
    ) {}

    override suspend fun loadSessions(
      gatewayId: String,
      agentId: String,
    ): List<ChatSessionEntry> = emptyList()

    override suspend fun loadTranscript(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
    ): List<ChatMessage> = emptyList()

    override suspend fun saveSessions(
      gatewayId: String,
      agentId: String,
      sessions: List<ChatSessionEntry>,
      retainedSessionKey: String?,
    ) {}

    override suspend fun saveTranscript(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
      messages: List<ChatMessage>,
      sessionInfo: ChatSessionEntry?,
    ) {}

    override suspend fun deleteSession(
      gatewayId: String,
      agentId: String,
      sessionKey: String,
    ) {}

    override suspend fun clearGateway(gatewayId: String) {
      groups = null
    }
  }

  @Test
  fun clearingGatewayRetiresPendingOfflineRestoreButAllowsAFreshRestore() =
    runTest {
      val cache = GroupCache().also { it.groups = catalog("Purged") }
      val release = CompletableDeferred<Unit>()
      cache.beforeRead = { release.await() }
      val f = Fixture(cache)
      val pending = async { f.groups.restoreOffline() }
      runCurrent()
      f.groups.clearGateway(f.scope.gatewayId)
      cache.groups = catalog("Fresh")
      release.complete(Unit)
      pending.await()
      assertEquals(emptyList<String>(), f.groups.catalog.value.names)
      cache.beforeRead = {}
      f.groups.restoreOffline()
      assertEquals(listOf("Fresh"), f.groups.catalog.value.names)
    }

  @Test
  fun offlineRestoreCannotReplaceALiveCatalogThatWasAlreadyInFlight() =
    runTest {
      val cache = GroupCache().also { it.groups = catalog("Cached") }
      val releaseCache = CompletableDeferred<Unit>()
      cache.beforeRead = { releaseCache.await() }
      val response = CompletableDeferred<String>()
      val f = Fixture(cache)
      f.response = { _, _ -> response.await() }
      val live = async { f.groups.refresh() }
      runCurrent()
      val offline = async { f.groups.restoreOffline() }
      runCurrent()
      response.complete(catalog("Live"))
      live.await()
      releaseCache.complete(Unit)
      offline.await()
      assertEquals(listOf("Live"), f.groups.catalog.value.names)
    }

  /** Models the Gateway receipt contract, not its database implementation. */
  private class ReceiptGateway(
    private val fixture: Fixture,
  ) {
    private val catalogs = mutableMapOf<LegacySessionGroupOwner, MutableSet<String>>()
    private val receipts = mutableMapOf<String, Pair<LegacySessionGroupOwner, MutableSet<String>>>()
    var loseNextImportAck = false
    var beforeImportAck: suspend () -> Unit = {}

    init {
      fixture.response = ::request
    }

    private suspend fun request(
      method: String,
      params: JsonObject,
    ): String {
      if (method == "users.self") return """{"profile":{"id":"${fixture.profile}"}}"""
      val owner = LegacySessionGroupOwner(fixture.scope.gatewayId, fixture.profile, (params.getValue("agentId") as JsonPrimitive).content)
      val names = catalogs.getOrPut(owner) { linkedSetOf() }
      when (method) {
        "sessions.groups.put" -> {
          assertEquals(JsonPrimitive(true), params["append"])
          val importId = (params["importId"] as? JsonPrimitive)?.content
          val consumed =
            importId?.let { id ->
              // The client must have durably claimed the exact destination before this mutation.
              assertEquals(owner, fixture.legacyOwner)
              assertEquals(fixture.importId, id)
              val receipt = receipts.getOrPut(id) { owner to mutableSetOf() }
              check(receipt.first == owner) { "import owner changed" }
              receipt.second
            }
          for (name in (params.getValue("names") as JsonArray).map { (it as JsonPrimitive).content }) {
            if (consumed == null || consumed.add(name)) names.add(name)
          }
          if (importId != null) {
            beforeImportAck()
            if (loseNextImportAck) {
              loseNextImportAck = false
              error("lost acknowledgment")
            }
          }
        }

        "sessions.groups.delete" -> {
          names.remove((params.getValue("name") as JsonPrimitive).content)
        }

        "sessions.groups.list" -> {}

        else -> {
          error("Unexpected group method: $method")
        }
      }
      return JsonObject(mapOf("groups" to JsonArray(names.map { JsonObject(mapOf("name" to JsonPrimitive(it))) }))).toString()
    }
  }

  @Test
  fun lostImportAckThenDeletionDoesNotResurrectButExplicitCreateStillWorks() =
    runTest {
      val f = Fixture()
      f.agent = f.defaultAgent
      f.legacy = listOf("Legacy")
      val gateway = ReceiptGateway(f)
      gateway.loseNextImportAck = true
      f.groups.refresh()
      assertEquals(listOf("Legacy"), f.legacy)
      assertEquals(listOf("Legacy"), f.groups.catalog.value.names)
      assertEquals("lost acknowledgment", f.groups.catalog.value.error)
      val route = requireNotNull(f.groups.capture(f.defaultAgent))
      assertTrue(f.groups.delete(route, "Legacy"))
      assertEquals(emptyList<String>(), f.groups.catalog.value.names)

      f.groups.refresh()
      assertEquals(emptyList<String>(), f.groups.catalog.value.names)
      assertEquals(emptyList<String>(), f.legacy)
      assertEquals(listOf(JsonPrimitive(f.importId), JsonPrimitive(f.importId)), f.requests.filter { it.first == "sessions.groups.put" }.map { it.second["importId"] })
      assertTrue(f.groups.create(route, "Legacy"))
      assertEquals(listOf("Legacy"), f.groups.catalog.value.names)
      assertFalse(
        f.requests
          .last { it.first == "sessions.groups.put" }
          .second
          .containsKey("importId"),
      )
    }

  @Test
  fun lostAckNeverCopiesToChangedGatewayProfileOrDefaultAndCatalogReadsContinue() =
    runTest {
      val switches: List<(Fixture) -> Unit> =
        listOf(
          { it.scope = ChatCacheScope("gateway-b", 2L) },
          { it.profile = "profile-b" },
          {
            it.defaultAgent = "other-default"
            it.agent = "other-default"
          },
        )
      for (switch in switches) {
        val f = Fixture()
        f.agent = f.defaultAgent
        f.legacy = listOf("Legacy")
        val gateway = ReceiptGateway(f)
        gateway.loseNextImportAck = true
        f.groups.refresh()
        val originalOwner = f.legacyOwner
        switch(f)
        f.groups.select()
        val currentRoute = requireNotNull(f.groups.capture(f.agent))
        assertTrue(f.groups.create(currentRoute, "Current owner's group"))
        f.groups.refresh()
        assertEquals(listOf("Legacy"), f.legacy)
        assertEquals(originalOwner, f.legacyOwner)
        assertEquals(listOf("Current owner's group"), f.groups.catalog.value.names)
        assertEquals(1, f.requests.count { it.first == "sessions.groups.put" && it.second.containsKey("importId") })
        assertEquals("sessions.groups.list", f.requests.last().first)
        assertTrue(
          f.groups.catalog.value.error!!
            .contains("original Gateway"),
        )
      }
    }

  @Test
  fun changedSourceDuringAcknowledgmentRetainsNewNamesAndReusesReceipt() =
    runTest {
      for (lostAck in listOf(false, true)) {
        val f = Fixture()
        f.agent = f.defaultAgent
        f.legacy = listOf("Legacy")
        val gateway = ReceiptGateway(f)
        gateway.loseNextImportAck = lostAck
        val importing = CompletableDeferred<Unit>()
        val releaseAck = CompletableDeferred<Unit>()
        gateway.beforeImportAck = {
          importing.complete(Unit)
          releaseAck.await()
        }
        val pending = async { f.groups.refresh() }
        runCurrent()
        assertTrue(importing.isCompleted)
        f.legacy = listOf("Legacy", "New during import")
        releaseAck.complete(Unit)
        pending.await()
        assertEquals(listOf("Legacy", "New during import"), f.legacy)
        assertTrue(f.groups.delete(requireNotNull(f.groups.capture(f.agent)), "Legacy"))

        f.groups.refresh()
        assertEquals(listOf("New during import"), f.groups.catalog.value.names)
        assertEquals(emptyList<String>(), f.legacy)
        val imports = f.requests.filter { it.first == "sessions.groups.put" }
        assertEquals(2, imports.size)
        assertTrue(imports.all { it.second["importId"] == JsonPrimitive(f.importId) })
        assertEquals(JsonArray(listOf(JsonPrimitive("Legacy"), JsonPrimitive("New during import"))), imports.last().second["names"])
      }
    }

  @Test
  fun createAppendsAndRenameDeleteUseExplicitCapturedRowOwner() =
    runTest {
      val f = Fixture()
      val route = requireNotNull(f.groups.capture("alpha"))
      f.agent = "beta"
      f.groups.select()
      assertTrue(f.groups.create(route, "New"))
      assertTrue(f.groups.rename(route, "Work", "Focus"))
      assertTrue(f.groups.delete(route, "Focus"))
      assertTrue(f.requests.all { it.second["agentId"] == JsonPrimitive("alpha") })
      val create = f.requests.first().second
      assertEquals(JsonPrimitive(true), create["append"])
      assertEquals(JsonArray(listOf(JsonPrimitive("New"))), create["names"])
      assertFalse(create.containsKey("sectionOrder"))
      assertFalse(create.containsKey("importId"))
      assertEquals("beta", f.groups.catalog.value.agentId)
      assertEquals(emptyList<String>(), f.groups.catalog.value.names)
      assertFalse(f.requests.any { it.first == "sessions.patch" })
    }

  @Test
  fun delayedAlphaCatalogCannotPopulateBetaAndEachKeepsEmptyOwnedGroups() =
    runTest {
      val f = Fixture()
      val alphaReply = CompletableDeferred<String>()
      f.response = { _, params -> if (params["agentId"] == JsonPrimitive("alpha")) alphaReply.await() else catalog("Beta empty") }
      val first = async { f.groups.refresh() }
      runCurrent()
      f.agent = "beta"
      f.groups.select()
      f.groups.refresh()
      alphaReply.complete(catalog("Alpha empty"))
      first.await()
      assertEquals(listOf("Beta empty"), f.groups.catalog.value.names)
      f.agent = "alpha"
      f.groups.select()
      assertEquals(listOf("Alpha empty"), f.groups.catalog.value.names)
    }

  @Test
  fun sameNamedCatalogsKeepIndependentOrderAndForeignInvalidationsDoNotReplaceSelection() =
    runTest {
      val f = Fixture()
      f.response = { _, params ->
        if (params["agentId"] == JsonPrimitive("alpha")) {
          """{"groups":[{"name":"Work","position":0},{"name":"Alpha empty","position":1}],"sectionOrder":["category:Work","category:Alpha empty"]}"""
        } else {
          """{"groups":[{"name":"Beta empty","position":0},{"name":"Work","position":1}],"sectionOrder":["category:Beta empty","category:Work"]}"""
        }
      }
      f.groups.refresh()
      f.agent = "beta"
      f.groups.select()
      f.groups.refresh()
      assertEquals(listOf("Beta empty", "Work"), f.groups.catalog.value.names)
      assertEquals(listOf("category:Beta empty", "category:Work"), f.groups.catalog.value.sectionOrder)
      assertFalse(f.groups.changed("alpha"))
      assertEquals(listOf("Beta empty", "Work"), f.groups.catalog.value.names)
      f.agent = "alpha"
      f.groups.select()
      assertEquals(emptyList<String>(), f.groups.catalog.value.names)
      f.groups.refresh()
      assertEquals(listOf("Work", "Alpha empty"), f.groups.catalog.value.names)
    }

  @Test
  fun newerSameOwnerResponseWinsAndOldConnectionCannotMutate() =
    runTest {
      val f = Fixture()
      val delayed = CompletableDeferred<String>()
      var reads = 0
      f.response = { _, _ -> if (++reads == 1) delayed.await() else catalog("Newer") }
      val first = async { f.groups.refresh() }
      runCurrent()
      f.groups.refresh()
      delayed.complete(catalog("Stale"))
      first.await()
      assertEquals(listOf("Newer"), f.groups.catalog.value.names)
      val oldRoute = requireNotNull(f.groups.capture("alpha"))
      f.scope = ChatCacheScope("gateway-b", 2L)
      f.groups.select()
      assertFalse(f.groups.delete(oldRoute, "Newer"))
      assertEquals(2, f.requests.size)
      assertEquals(emptyList<String>(), f.groups.catalog.value.names)
    }

  @Test
  fun legacyImportsOnceToConfiguredDefaultNotVisitedAgent() =
    runTest {
      val f = Fixture()
      f.legacy = listOf("Legacy empty", "Work")
      f.groups.refresh()
      assertEquals(emptyList<String>(), f.legacy)
      f.agent = "beta"
      f.groups.select()
      f.groups.refresh()
      val imports = f.requests.filter { it.first == "sessions.groups.put" }
      assertEquals(1, imports.size)
      assertEquals(JsonPrimitive("configured-default"), imports.single().second["agentId"])
      assertEquals(JsonPrimitive(true), imports.single().second["append"])
      assertEquals(JsonPrimitive(f.importId), imports.single().second["importId"])
      assertEquals(JsonArray(listOf(JsonPrimitive("Legacy empty"), JsonPrimitive("Work"))), imports.single().second["names"])
    }

  @Test
  fun failedMigrationRetainsSourceAndNeverFallsBack() =
    runTest {
      val f = Fixture()
      f.legacy = listOf("Legacy")
      f.response = { method, _ ->
        when (method) {
          "users.self" -> """{"profile":{"id":"profile-a"}}"""
          "sessions.groups.list" -> catalog("Canonical current-owner group")
          else -> error("permission denied")
        }
      }
      f.groups.refresh()
      assertEquals(listOf("Legacy"), f.legacy)
      assertEquals(listOf("users.self", "sessions.groups.put", "sessions.groups.list"), f.requests.map { it.first })
      assertEquals(listOf("Canonical current-owner group"), f.groups.catalog.value.names)
      assertEquals("permission denied", f.groups.catalog.value.error)
    }

  @Test
  fun delayedMigrationAckAfterGatewayOrDefaultOwnerChangeDoesNotClearSource() =
    runTest {
      for (changeGateway in listOf(false, true)) {
        val f = Fixture()
        f.legacy = listOf("Legacy")
        val ack = CompletableDeferred<String>()
        f.response = { method, _ -> if (method == "users.self") """{"profile":{"id":"profile-a"}}""" else ack.await() }
        val import = async { f.groups.refresh() }
        runCurrent()
        if (changeGateway) f.scope = ChatCacheScope("gateway-b", 2L) else f.defaultAgent = "other-default"
        ack.complete(catalog("Legacy"))
        import.await()
        assertEquals(listOf("Legacy"), f.legacy)
        assertEquals(JsonPrimitive("configured-default"), f.requests.first { it.first == "sessions.groups.put" }.second["agentId"])
      }
    }

  @Test
  fun ambiguousImportIsNeverRetargetedToAnotherGatewayProfileOrDefault() =
    runTest {
      val f = Fixture()
      f.legacy = listOf("Legacy")
      f.response = { method, _ ->
        if (method == "users.self") """{"profile":{"id":"profile-a"}}""" else error("lost acknowledgment")
      }
      f.groups.refresh()
      assertEquals(LegacySessionGroupOwner("gateway-a", "profile-a", "configured-default"), f.legacyOwner)
      f.scope = ChatCacheScope("gateway-b", 2L)
      f.defaultAgent = "other-default"
      f.response = { method, _ -> if (method == "users.self") """{"profile":{"id":"profile-b"}}""" else catalog("Other") }
      f.groups.select()
      f.groups.refresh()
      assertEquals(1, f.requests.count { it.first == "sessions.groups.put" })
      assertEquals(listOf("Legacy"), f.legacy)
      assertEquals(listOf("Other"), f.groups.catalog.value.names)
    }

  @Test
  fun changedProfileDoesNotAcknowledgeLegacySource() =
    runTest {
      val f = Fixture()
      f.legacy = listOf("Legacy")
      f.response = { method, _ ->
        if (method == "users.self") {
          """{"profile":{"id":"${f.profile}"}}"""
        } else {
          f.profile = "profile-b"
          catalog("Legacy")
        }
      }
      f.groups.refresh()
      assertEquals(listOf("Legacy"), f.legacy)
    }

  @Test
  fun oldGatewayNeverUsesGlobalCatalogEvenForOneVisibleAgent() =
    runTest {
      val f = Fixture()
      f.supports = false
      f.legacy = listOf("Legacy")
      f.groups.refresh()
      assertFalse(f.groups.create(requireNotNull(f.groups.capture("alpha")), "New"))
      assertTrue(f.requests.isEmpty())
      assertEquals(SESSION_GROUPS_UNSUPPORTED, f.groups.catalog.value.error)
      assertEquals(listOf("Legacy"), f.legacy)
    }

  companion object {
    private fun catalog(name: String): String = """{"groups":[{"name":"$name","position":0}],"sectionOrder":["category:$name"]}"""
  }
}

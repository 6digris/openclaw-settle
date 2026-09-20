package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainActivity
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.Closeable
import java.io.File
import java.net.HttpURLConnection
import java.net.URI
import java.util.Base64
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

/** Real onboarding, GatewaySession, controller, and UI; the Gateway never executes a command. */
@RunWith(AndroidJUnit4::class)
class TaskProgressGatewayTest {
  @Test
  fun crossAgentProgressAfterYieldPreservesDraftAndAuthoredChecklist() {
    val arguments = InstrumentationRegistry.getArguments()
    val gatewayUrl = arguments.getString("taskProgressGatewayUrl")
    val controlUrl = arguments.getString("taskProgressControlUrl")
    assumeTrue("This opt-in proof requires the owned synthetic Gateway URLs", gatewayUrl != null || controlUrl != null)
    requireNotNull(gatewayUrl) { "Pass taskProgressGatewayUrl through the instrumentation runner" }
    requireNotNull(controlUrl) { "Pass taskProgressControlUrl through the instrumentation runner" }
    val gateway = URI(gatewayUrl)
    val control = URI(controlUrl)
    require(gateway.scheme == "ws" && gateway.host == "127.0.0.1" && gateway.port > 0)
    require(control.scheme == "http" && control.host == "127.0.0.1" && control.port == gateway.port)
    val terminal = arguments.getString("taskProgressTerminalStage") ?: "failed"
    require(terminal == "failed" || terminal == "completed")

    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.uiAutomation.serviceInfo =
      instrumentation.uiAutomation.serviceInfo.apply {
        flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
      }
    val context = instrumentation.targetContext
    val device = UiDevice.getInstance(instrumentation)
    val proofDirectory = File(context.filesDir, "task-progress-$terminal")
    val proofArchive =
      File(
        requireNotNull(arguments.getString("additionalTestOutputDir")) {
          "Run this proof through Gradle additional test output collection"
        },
        "task-progress-$terminal.zip",
      )
    check(proofDirectory.isDirectory || proofDirectory.mkdirs())
    val fixture = Fixture(controlUrl.trimEnd('/'))
    assertEquals("agent:main:main", fixture.request("reset", JSONObject()).getString("sessionKey"))
    val setupCode =
      Base64.getUrlEncoder().withoutPadding().encodeToString(
        JSONObject()
          .put("url", gatewayUrl)
          .put("token", "synthetic-attention-token")
          .toString()
          .toByteArray(Charsets.UTF_8),
      )
    val intent =
      Intent(context, MainActivity::class.java)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
    var onboardingFinished = false
    // AGP pulls additional outputs one file at a time. Export one closed, verifiable bundle.
    val bundle =
      Closeable {
        ZipOutputStream(proofArchive.outputStream()).use { archive ->
          for (file in checkNotNull(proofDirectory.listFiles()).sortedBy { it.name }) {
            archive.putNextEntry(ZipEntry(file.name))
            file.inputStream().use { it.copyTo(archive) }
            archive.closeEntry()
          }
        }
      }
    bundle.use {
      ActivityScenario.launch<MainActivity>(intent).use {
        try {
          // The caller clears only this proof emulator's debug app before launch. No screenshot-mode extras or preference seeding.
          connectThroughOnboarding(device, setupCode)
          onboardingFinished = true
          requireObject(device, By.desc("Show Sidebar")).click()
          requireObject(device, By.text("Pages")).click()
          requireObject(device, By.text("Recent")).click()
          capture(device, proofDirectory, "00-parent-session-picker", fixture)
          requireObject(device, By.text("Synthetic parent")).click()
          requireObject(device, By.desc("Add attachment"))
          requireObject(device, By.text("Your research workspace is ready."))
          val sessionReads = fixture.request("evidence").getJSONArray("requests")
          val selectedHistory =
            (0 until sessionReads.length())
              .map(sessionReads::getJSONObject)
              .last { it.getString("method") == "chat.history" }
          assertEquals("Select the fixture parent, not the device Home", "agent:main:main", selectedHistory.optString("sessionKey"))
          editComposer(device, "Show the synthetic worker progress.")
          requireObject(device, By.desc("Send").enabled(true)).click()
          requireObject(device, By.text("Parent yielded; synthetic worker continues."))
          requireObject(device, By.text("Prepared worker commentary: reviewing synthetic notes."))
          requireObject(device, By.text("Subagent working"))

          val draft = "Keep this Android draft while the worker updates."
          editComposer(device, draft)
          assertDraft(device, draft)
          capture(device, proofDirectory, "01-yielded-editor", fixture)
          assertChecklist(device)
          capture(device, proofDirectory, "02-yielded-checklist", fixture)
          requireObject(device, By.desc("Collapse progress card")).click()
          val yielded = fixture.request("evidence")
          assertTrue("The synthetic parent must yield, not complete its child", yielded.getBoolean("parentYielded"))
          assertEquals("yielded", yielded.getString("stage"))
          assertWireBoundary(yielded)
          val authoredCard = yielded.getJSONObject("card").toString()

          fixture.request("advance", JSONObject().put("stage", "working"))
          requireObject(device, By.text("printf synthetic-progress-check"))
          requireObject(device, By.text("Subagent working"))
          assertDraft(device, draft)
          capture(device, proofDirectory, "03-working-editor", fixture)

          fixture.request("advance", JSONObject().put("stage", "unknown"))
          requireObject(device, By.text("printf synthetic-outcome-unavailable"))
          requireObject(device, By.text("Subagent activity unavailable"))
          assertFalse(device.hasObject(By.text("Subagent finished")))
          assertFalse(device.hasObject(By.text("Subagent failed")))
          assertDraft(device, draft)
          capture(device, proofDirectory, "04-unknown-editor", fixture)
          val unknownTask = fixture.request("evidence").getJSONObject("task")
          assertEquals("running", unknownTask.getString("status"))
          val unknownItems = unknownTask.getJSONObject("progress").getJSONArray("items")
          assertFalse("An absent synthetic tool outcome is not success", unknownItems.getJSONObject(unknownItems.length() - 1).has("status"))

          fixture.request("advance", JSONObject().put("stage", terminal))
          requireObject(device, By.text("Synthetic worker $terminal; no command was executed."))
          requireObject(device, By.text(if (terminal == "failed") "Subagent failed" else "Subagent finished"))
          requireObject(device, By.text("Synthetic final: $terminal fixture result; no command was executed."))
          assertDraft(device, draft)
          capture(device, proofDirectory, "05-$terminal-editor", fixture)
          assertChecklist(device)
          assertDraft(device, draft)
          capture(device, proofDirectory, "06-$terminal-checklist", fixture)
          val finished = fixture.request("evidence")
          assertEquals(terminal, finished.getString("stage"))
          assertEquals("Worker terminal events must not rewrite the authored checklist", authoredCard, finished.getJSONObject("card").toString())

          requireObject(device, By.desc("Collapse progress card")).click()
          val editedDraft = "$draft Still editable."
          editComposer(device, editedDraft)
          assertDraft(device, editedDraft)
          capture(device, proofDirectory, "07-terminal-editable", fixture)
          val requests = fixture.request("evidence").getJSONArray("requests")
          assertEquals("Editing the retained draft must not send a second prompt", 1, (0 until requests.length()).count { requests.getJSONObject(it).getString("method") == "chat.send" })
        } catch (failure: Throwable) {
          // Onboarding fields can contain setup credentials; retain UI diagnostics only after leaving those screens.
          runCatching {
            if (onboardingFinished) {
              capture(device, proofDirectory, "failure", fixture)
            } else {
              File(proofDirectory, "failure-gateway.json").writeText(fixture.request("evidence").toString(2))
            }
          }.exceptionOrNull()?.let(failure::addSuppressed)
          throw failure
        }
      }
    }
  }

  private fun connectThroughOnboarding(
    device: UiDevice,
    setupCode: String,
  ) {
    requireObject(device, By.text("Continue")).click()
    requireObject(device, By.text("Scan QR or setup code")).click()
    requireObject(device, By.text("Enter setup code")).click()
    requireObject(device, By.clazz("android.widget.EditText")).text = setupCode
    hideKeyboard(device)
    requireObject(device, By.text("Use setup code")).click()
    requireObject(device, By.text("Gateway paired"))
    requireObject(device, By.text("Continue")).click()
    requireObject(device, By.text("Permissions"))
    requireObject(device, By.text("Continue")).click()
    requireObject(device, By.desc("Show Sidebar"))
  }

  private fun editComposer(
    device: UiDevice,
    text: String,
  ) {
    val composer = requireObject(device, By.clazz("android.widget.EditText").enabled(true))
    composer.click()
    composer.text = text
    hideKeyboard(device)
  }

  private fun hideKeyboard(device: UiDevice) {
    val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
    device.waitForIdle()
    if (automation.windows.any { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }) device.pressBack()
    device.waitForIdle()
  }

  private fun assertDraft(
    device: UiDevice,
    draft: String,
  ) {
    val composer = requireObject(device, By.clazz("android.widget.EditText").enabled(true))
    assertEquals("Gateway task updates must preserve the editable draft", draft, composer.text)
    requireObject(device, By.desc("Send").enabled(true))
  }

  private fun assertChecklist(device: UiDevice) {
    requireObject(device, By.desc("Expand progress card")).click()
    requireObject(device, By.text("Review synthetic notes"))
    requireObject(device, By.text("Report synthetic result"))
    requireObject(device, By.text("Authored checklist; worker updates do not rewrite these steps."))
    requireObject(device, By.textContains("1/2"))
  }

  private fun assertWireBoundary(evidence: JSONObject) {
    val connections = evidence.getJSONArray("connections")
    assertTrue(
      "The real Android operator connection must advertise task-progress support",
      (0 until connections.length()).any {
        val connection = connections.getJSONObject(it)
        connection.getString("role") == "operator" && connection.getBoolean("taskProgress")
      },
    )
    val requests = evidence.getJSONArray("requests")
    for (method in listOf("chat.send", "chat.history", "tasks.list", "progressCard.get")) {
      assertTrue(
        "The app must consume $method through its real Gateway transport",
        (0 until requests.length()).any {
          val request = requests.getJSONObject(it)
          request.getString("method") == method && request.optString("sessionKey") == "agent:main:main"
        },
      )
    }
    val events = evidence.getJSONArray("events")
    assertTrue(
      "The Gateway must emit a yielded parent final to the native operator",
      (0 until events.length()).any {
        val event = events.getJSONObject(it)
        event.getString("event") == "chat" && event.optBoolean("yielded") && event.getInt("recipients") > 0
      },
    )
    assertTrue(
      "Prepared child progress must be delivered to a capability-advertising native operator",
      (0 until events.length()).any {
        val event = events.getJSONObject(it)
        event.getString("event") == "task" && event.getInt("taskProgressRecipients") > 0
      },
    )
    val task = evidence.getJSONObject("task")
    assertEquals("worker", task.getString("agentId"))
    assertEquals("subagent", task.getString("runtime"))
    assertEquals("agent:main:main", task.getString("sessionKey"))
    assertEquals("agent:main:main", task.getString("ownerKey"))
    assertEquals("agent:worker:subagent:native-progress", task.getString("childSessionKey"))
    assertFalse("Legacy text must not make prepared-progress proof pass", task.has("progressSummary"))
    assertFalse("Legacy text must not make prepared-progress proof pass", task.has("lastActivity"))
  }

  private fun requireObject(
    device: UiDevice,
    selector: BySelector,
  ): UiObject2 = checkNotNull(device.wait(Until.findObject(selector), 15000)) { "Native Gateway proof could not find $selector" }

  private fun capture(
    device: UiDevice,
    directory: File,
    stage: String,
    fixture: Fixture,
  ) {
    device.waitForIdle()
    assertTrue("Could not capture native $stage screenshot", device.takeScreenshot(File(directory, "android-$stage.png")))
    device.dumpWindowHierarchy(File(directory, "android-$stage.xml"))
    File(directory, "android-$stage-gateway.json").writeText(fixture.request("evidence").toString(2))
  }

  private class Fixture(
    private val controlUrl: String,
  ) {
    fun request(
      action: String,
      body: JSONObject? = null,
    ): JSONObject {
      val connection = URI("$controlUrl/task-progress/$action").toURL().openConnection() as HttpURLConnection
      try {
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        if (body != null) {
          connection.requestMethod = "POST"
          connection.doOutput = true
          connection.setRequestProperty("Content-Type", "application/json")
          connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
        }
        check(connection.responseCode == 200) { "Synthetic task Gateway $action returned HTTP ${connection.responseCode}" }
        return connection.inputStream.bufferedReader().use { JSONObject(it.readText()) }
      } finally {
        connection.disconnect()
      }
    }
  }
}

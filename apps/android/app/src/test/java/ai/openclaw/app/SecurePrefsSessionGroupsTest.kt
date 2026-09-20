package ai.openclaw.app

import android.content.Context
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SecurePrefsSessionGroupsTest {
  @Test
  fun changedLegacySourceSurvivesAcknowledgmentOfTheCapturedNames() {
    val context = RuntimeEnvironment.getApplication()
    val plain = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plain.edit().putString("sessions.customGroups", "[\"Legacy\"]").commit()
    val prefs = SecurePrefs(context)
    val captured = prefs.legacySessionGroupNames()
    plain.edit().putString("sessions.customGroups", "[\"Legacy\",\"New during import\"]").commit()

    prefs.acknowledgeLegacySessionGroupNames(captured)

    val reopened = SecurePrefs(context)
    assertEquals(listOf("Legacy", "New during import"), reopened.legacySessionGroupNames())
    reopened.acknowledgeLegacySessionGroupNames(reopened.legacySessionGroupNames())
    assertFalse(plain.contains("sessions.customGroups"))
  }

  @Test
  fun legacyNamesRemainMigrationSourceUntilMatchingAcknowledgment() {
    val context = RuntimeEnvironment.getApplication()
    val plain = context.getSharedPreferences("openclaw.node", Context.MODE_PRIVATE)
    plain.edit().putString("sessions.customGroups", "[\"Empty\",\"Work\"]").commit()
    val prefs = SecurePrefs(context)
    val captured = prefs.legacySessionGroupNames()
    assertEquals(listOf("Empty", "Work"), captured)
    prefs.acknowledgeLegacySessionGroupNames(listOf("Wrong"))
    assertEquals(captured, prefs.legacySessionGroupNames())
    prefs.acknowledgeLegacySessionGroupNames(captured)
    assertFalse(plain.contains("sessions.customGroups"))
    assertEquals(emptyList<String>(), SecurePrefs(context).legacySessionGroupNames())
  }
}

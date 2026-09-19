package ai.openclaw.app.ui.design

import android.graphics.Bitmap
import android.provider.Settings
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.captureToImage
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.rules.RuleChain
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import android.graphics.Color as AndroidColor

/** Pixel proof through the production Canvas and its real frame clock, not a pose-only assertion. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], qualifiers = "w360dp-h800dp-420dpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MascotRenderingTest {
  private val compose = createComposeRule()
  private var previousScale: String? = null
  private var mood by mutableStateOf(MascotMood.Idle)
  private var speaking by mutableStateOf(false)

  @get:Rule
  val rules: RuleChain =
    RuleChain
      .outerRule(
        object : ExternalResource() {
          override fun before() {
            previousScale = Settings.Global.getString(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE)
          }

          override fun after() {
            Settings.Global.putString(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, previousScale)
          }
        },
      ).around(compose)

  private fun mount(
    reduced: Boolean = false,
    tinted: Boolean = false,
  ) {
    Settings.Global.putFloat(RuntimeEnvironment.getApplication().contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, if (reduced) 0f else 1f)
    compose.mainClock.autoAdvance = false
    compose.setContent {
      ClawDesignTheme {
        OpenClawMascot(Modifier.size(240.dp).testTag("rendered-mascot"), tint = if (tinted) Color(0xFF5080C0) else null, mood = mood, speaking = speaking)
      }
    }
    compose.mainClock.advanceTimeByFrame()
  }

  private fun frame(
    name: String,
    advanceMs: Long = 80,
  ): Bitmap {
    compose.mainClock.advanceTimeBy(advanceMs)
    return compose
      .onNodeWithTag("rendered-mascot")
      .captureToImage()
      .asAndroidBitmap()
      .also { it.saveMascotFrame(name) }
  }

  @Test
  fun mouthRemainsVisibleAcrossAnimatedSpeechPauseThinkingAndMute() {
    mount()
    val frames = mutableListOf<Pair<String, Int>>()

    fun capture(name: String) {
      frames += name to frame(name).mascotMouthPixels()
    }
    capture("motion-00-idle")
    compose.runOnIdle { speaking = true }
    repeat(6) { capture("motion-01-speaking-" + it) }
    compose.runOnIdle {
      speaking = false
      mood = MascotMood.Thinking
    }
    repeat(4) { capture("motion-02-pause-thinking-" + it) }
    compose.runOnIdle { mood = MascotMood.Idle }
    repeat(4) { capture("motion-03-listening-muted-" + it) }
    assertTrue("Every untinted frame must retain visible mouth pixels: $frames", frames.all { it.second > 0 })
    assertTrue(
      "Audible frames must animate their rendered mouth",
      frames
        .filter { "speaking" in it.first }
        .map { it.second }
        .distinct()
        .size > 1,
    )
  }

  @Test
  fun reducedMotionRetainsClosedMouthAndEveryExistingMoodExpression() {
    mount(reduced = true)
    val frames = mutableListOf<Pair<String, Int>>()
    for (value in MascotMood.entries) {
      compose.runOnIdle {
        mood = value
        speaking = false
      }
      val silent = frame("reduced-$value")
      frames += value.name to silent.mascotMouthPixels()
      compose.runOnIdle { speaking = true }
      val mutedMotion = frame("reduced-$value-speaking-gated")
      assertTrue("Reduced motion must not start speech animation for $value", silent.sameAs(mutedMotion))
    }
    assertTrue("Static mood faces retain their mouth: $frames", frames.all { it.second > 0 })
  }

  @Test
  fun tintedSilhouettesNeverAcquireFaceOrSpeechPixels() {
    mount(tinted = true)
    for (value in MascotMood.entries) {
      compose.runOnIdle {
        mood = value
        speaking = true
      }
      val image = frame("tinted-$value")
      assertEquals("Tinted silhouette preserves no facial drawing", 0, image.mascotMouthPixels())
      val center = image.getPixel(image.width / 2, image.height * 50 / 120)
      assertEquals(AndroidColor.rgb(80, 128, 192), center)
    }
  }
}

/** Central art-space band follows all bounded float/tilt poses, excluding eyes and other dark features. */
internal fun Bitmap.mascotMouthPixels(): Int {
  val scale = minOf(width, height) / 120.0
  var count = 0
  for (y in (32 * scale).toInt() until (64 * scale).toInt()) {
    for (x in (56 * scale).toInt() until (64 * scale).toInt()) {
      val pixel = getPixel(x, y)
      if (AndroidColor.alpha(pixel) > 200 && AndroidColor.red(pixel) < 40 && AndroidColor.green(pixel) < 40 && AndroidColor.blue(pixel) < 55) count++
    }
  }
  return count
}

internal fun Bitmap.saveMascotFrame(name: String) {
  val root = System.getenv("OPENCLAW_TALK_PROOF_DIR") ?: return
  val folder = File(root).also { check(it.isDirectory || it.mkdirs()) }
  File(folder, "$name.png").outputStream().use { check(compress(Bitmap.CompressFormat.PNG, 100, it)) }
}

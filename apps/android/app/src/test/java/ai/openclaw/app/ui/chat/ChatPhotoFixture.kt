package ai.openclaw.app.ui.chat

import android.graphics.Bitmap
import android.graphics.Color
import android.util.Base64
import java.io.ByteArrayOutputStream

/** A real high-detail JPEG within camera/composer limits but above the inline preview budget. */
internal fun syntheticLargeChatPhotoBase64(): String {
  val width = 1024
  val height = 768
  var seed = 7
  val pixels =
    IntArray(width * height) {
      seed = seed * 1664525 + 1013904223
      Color.rgb((seed ushr 16) and 255, (seed ushr 8) and 255, seed and 255)
    }
  val bitmap = Bitmap.createBitmap(pixels, width, height, Bitmap.Config.ARGB_8888)
  return try {
    ByteArrayOutputStream().use { output ->
      check(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, output))
      Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }
  } finally {
    bitmap.recycle()
  }
}

/** Same real Bitmap/JPEG fixture boundary used by ChatImageCodecTest; no device camera. */
internal fun syntheticChatPhotoBase64(): String {
  val bitmap = Bitmap.createBitmap(120, 80, Bitmap.Config.ARGB_8888)
  return try {
    for (y in 0 until bitmap.height) {
      for (x in 0 until bitmap.width) {
        bitmap.setPixel(
          x,
          y,
          when {
            x < bitmap.width / 2 && y < bitmap.height / 2 -> Color.RED
            x >= bitmap.width / 2 && y < bitmap.height / 2 -> Color.GREEN
            x < bitmap.width / 2 -> Color.BLUE
            else -> Color.YELLOW
          },
        )
      }
    }
    ByteArrayOutputStream().use { output ->
      check(bitmap.compress(Bitmap.CompressFormat.JPEG, 100, output))
      Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
    }
  } finally {
    bitmap.recycle()
  }
}

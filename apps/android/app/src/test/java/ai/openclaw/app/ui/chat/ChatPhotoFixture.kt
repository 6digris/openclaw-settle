package ai.openclaw.app.ui.chat

import android.graphics.Bitmap
import android.graphics.Color
import android.util.Base64
import java.io.ByteArrayOutputStream

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

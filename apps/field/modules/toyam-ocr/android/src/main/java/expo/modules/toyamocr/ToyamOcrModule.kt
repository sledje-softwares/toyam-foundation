// On-device text recognition for the field app (docs/11 "Device OCR and description", gap 35).
//
// Google ML Kit text recognition v2 with the **bundled** Latin and Devanagari models (work offline, no
// Play-services download). JS: src/ocr/native.ts. Runs on its own low-priority thread, so neither the
// UI thread nor the shared Expo module queue is blocked; one image at a time.
//
// recognize(uri, scripts) -> { width, height, latin?: Text, devanagari?: Text }
//   Text = { blocks: [{ lines: [{ text, frame: {left, top, width, height} | null, confidence }] }] }
//   Coordinates are pixels of the decoded (upright) image.
package expo.modules.toyamocr

import android.net.Uri
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Keep in step with android/build.gradle (recorded with every result as evidence_ocr.engine_version). */
private const val ENGINE_VERSION = "mlkit-text 16.0.1 + devanagari 16.0.1 (bundled)"

class ToyamOcrModule : Module() {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor { r ->
    Thread(r, "toyam-ocr").apply { priority = Thread.MIN_PRIORITY }
  }
  private var latin: TextRecognizer? = null
  private var devanagari: TextRecognizer? = null

  private fun client(script: String): TextRecognizer =
    if (script == "devanagari") {
      devanagari ?: TextRecognition.getClient(DevanagariTextRecognizerOptions.Builder().build()).also { devanagari = it }
    } else {
      latin ?: TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS).also { latin = it }
    }

  override fun definition() = ModuleDefinition {
    Name("ToyamOcr")

    Function("engineVersion") { ENGINE_VERSION }

    AsyncFunction("recognize") { uri: String, scripts: List<String>, promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject("ERR_OCR_CONTEXT", "No Android context", null)
      } else {
        executor.execute {
          try {
            val image = InputImage.fromFilePath(context, Uri.parse(uri))
            val out = HashMap<String, Any?>()
            out["width"] = image.width
            out["height"] = image.height
            for (script in scripts.distinct()) {
              val key = if (script == "devanagari") "devanagari" else "latin"
              val text = Tasks.await(client(key).process(image), 30, TimeUnit.SECONDS)
              out[key] = textToMap(text)
            }
            promise.resolve(out)
          } catch (e: Throwable) {
            promise.reject("ERR_OCR", e.message ?: e.javaClass.simpleName, e)
          }
        }
      }
    }

    OnDestroy {
      executor.shutdown()
      latin?.close()
      devanagari?.close()
    }
  }

  private fun textToMap(text: Text): Map<String, Any?> = mapOf(
    "blocks" to text.textBlocks.map { block ->
      mapOf(
        "lines" to block.lines.map { line ->
          val r = line.boundingBox
          mapOf(
            "text" to line.text,
            "frame" to r?.let { mapOf("left" to it.left, "top" to it.top, "width" to it.width(), "height" to it.height()) },
            "confidence" to line.confidence.toDouble(),
          )
        },
      )
    },
  )
}

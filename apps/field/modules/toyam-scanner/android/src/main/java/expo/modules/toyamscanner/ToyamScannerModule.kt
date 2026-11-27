// Document scanning for the field app (docs/11 "Document scan").
//
// Google ML Kit document scanner: its own full-screen camera finds the page edges, corrects the
// perspective and cleans shadows; the operator can adjust the crop and filter before saving. It needs
// Google Play services and downloads its models once. The app needs no camera permission for it.
//
// scan(pageLimit) -> [{ uri, width, height }] (one JPEG per page, upright), or [] when cancelled.
// Gallery import stays off, so every page comes from the camera (capture_source 'camera').
package expo.modules.toyamscanner

import android.app.Activity
import android.graphics.BitmapFactory
import android.net.Uri
import com.google.mlkit.vision.documentscanner.GmsDocumentScannerOptions
import com.google.mlkit.vision.documentscanner.GmsDocumentScanning
import com.google.mlkit.vision.documentscanner.GmsDocumentScanningResult
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val REQUEST_SCAN = 0x5CA1

class ToyamScannerModule : Module() {
  private var pending: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("ToyamScanner")

    AsyncFunction("scan") { pageLimit: Int, promise: Promise ->
      if (pending != null) {
        promise.reject("ERR_SCAN_BUSY", "A scan is already open", null)
        return@AsyncFunction
      }
      val activity = appContext.currentActivity
      if (activity == null) {
        promise.reject("ERR_SCAN_ACTIVITY", "No Android activity", null)
        return@AsyncFunction
      }
      val options = GmsDocumentScannerOptions.Builder()
        .setScannerMode(GmsDocumentScannerOptions.SCANNER_MODE_FULL)
        .setGalleryImportAllowed(false)
        .setPageLimit(pageLimit.coerceAtLeast(1))
        .setResultFormats(GmsDocumentScannerOptions.RESULT_FORMAT_JPEG)
        .build()
      pending = promise
      GmsDocumentScanning.getClient(options).getStartScanIntent(activity)
        .addOnSuccessListener { sender ->
          try {
            activity.startIntentSenderForResult(sender, REQUEST_SCAN, null, 0, 0, 0)
          } catch (e: Throwable) {
            fail(e)
          }
        }
        .addOnFailureListener { e -> fail(e) }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_SCAN) return@OnActivityResult
      val promise = pending ?: return@OnActivityResult
      pending = null
      when (payload.resultCode) {
        Activity.RESULT_CANCELED -> promise.resolve(emptyList<Map<String, Any>>())
        Activity.RESULT_OK -> {
          val pages = GmsDocumentScanningResult.fromActivityResultIntent(payload.data)?.pages.orEmpty()
          if (pages.isEmpty()) {
            promise.reject("ERR_SCAN", "The scanner returned no pages", null)
          } else {
            promise.resolve(pages.map { page(it.imageUri) })
          }
        }
        else -> promise.reject("ERR_SCAN", "The scanner failed (${payload.resultCode})", null)
      }
    }
  }

  private fun fail(e: Throwable) {
    pending?.reject("ERR_SCAN", e.message ?: e.javaClass.simpleName, e)
    pending = null
  }

  /** The size is needed by the app's resize step; only the header is read. */
  private fun page(uri: Uri): Map<String, Any> {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    runCatching {
      appContext.reactContext?.contentResolver?.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    }
    return mapOf("uri" to uri.toString(), "width" to bounds.outWidth.coerceAtLeast(0), "height" to bounds.outHeight.coerceAtLeast(0))
  }
}

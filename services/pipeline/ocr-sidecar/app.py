"""PaddleOCR sidecar for the processing pipeline worker (services/pipeline, D34 / D38).

Contract (services/pipeline/src/ocr-engine.ts):
    POST /ocr      body = file bytes; Content-Type image/jpeg|png|webp|tiff or application/pdf;
                   optional Authorization: Bearer <OCR_TOKEN>, X-Max-Pages: n
                   200 {"engine","engine_version","lang","pages":[{"page_no","width","height","text",
                        "mean_confidence","blocks":[{"text","bbox":[x,y,w,h],"conf","line"}]}]}
                   4xx {"error"} for bad input (not retried), 5xx for engine failures (retried)
    GET  /health   200 {"ok": true, "engine", "engine_version"}

Coordinates are pixels of the original image (rendered page pixels at PDF_DPI for PDFs), top-left origin.
Nothing is written to disk and nothing is logged about the content (case documents are personal data).

Environment:
    PORT (8866), HOST (127.0.0.1; 0.0.0.0 inside a container network), OCR_TOKEN (optional shared secret),
    OCR_LANG (en), OCR_MAX_BYTES (62914560), OCR_MAX_EDGE (2400: larger images are shrunk before OCR,
    boxes are scaled back), PDF_DPI (200), OCR_SIDECAR_ENGINE (paddle | fake; fake answers a fixed block
    without decoding anything, for contract tests).
Standard library HTTP server; one OCR at a time (PaddleOCR is not thread-safe; the worker's concurrency
queues behind it).
"""

from __future__ import annotations

import hmac
import io
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("PORT", "8866"))
HOST = os.environ.get("HOST", "127.0.0.1")
TOKEN = os.environ.get("OCR_TOKEN", "")
LANG = os.environ.get("OCR_LANG", "en")
MAX_BYTES = int(os.environ.get("OCR_MAX_BYTES", str(60 * 1024 * 1024)))
MAX_EDGE = int(os.environ.get("OCR_MAX_EDGE", "2400"))
PDF_DPI = int(os.environ.get("PDF_DPI", "200"))
ENGINE = os.environ.get("OCR_SIDECAR_ENGINE", "paddle")

IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/tiff"}
PDF_TYPE = "application/pdf"


class BadInput(Exception):
    pass


def log(event: str, **fields) -> None:
    sys.stdout.write(json.dumps({"ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "event": event, **fields}) + "\n")
    sys.stdout.flush()


# ---------------------------------------------------------------------------------------------------
# Engines
# ---------------------------------------------------------------------------------------------------
class FakeEngine:
    name = "fake"
    version = "0"

    def read(self, data: bytes, mime: str, max_pages: int) -> list[dict]:
        return [{
            "page_no": 1, "width": 0, "height": 0, "text": "MH 12 AB 1234", "mean_confidence": 0.9,
            "blocks": [{"text": "MH 12 AB 1234", "bbox": [0, 0, 100, 20], "conf": 0.9, "line": 1}],
        }]


class PaddleEngine:
    name = "paddleocr"

    def __init__(self) -> None:
        import numpy  # noqa: F401  (fail fast if the image is incomplete)
        from PIL import Image
        import paddleocr

        Image.MAX_IMAGE_PIXELS = 100_000_000          # refuse decompression bombs
        self.version = getattr(paddleocr, "__version__", "unknown")
        self.major = int(str(self.version).split(".")[0]) if str(self.version)[:1].isdigit() else 3
        if self.major >= 3:
            self.ocr = paddleocr.PaddleOCR(
                lang=LANG,
                use_doc_orientation_classify=False,
                use_doc_unwarping=False,
                use_textline_orientation=True,
            )
        else:  # 2.x API
            self.ocr = paddleocr.PaddleOCR(lang=LANG, use_angle_cls=True, show_log=False)
        self.lock = threading.Lock()

    # -- decoding ---------------------------------------------------------------------------------
    def _images(self, data: bytes, mime: str, max_pages: int):
        from PIL import Image, ImageOps

        if mime == PDF_TYPE:
            import pypdfium2 as pdfium

            try:
                pdf = pdfium.PdfDocument(data)
            except Exception as exc:  # noqa: BLE001
                raise BadInput(f"not a readable PDF: {type(exc).__name__}") from exc
            try:
                for i in range(min(len(pdf), max_pages)):
                    page = pdf[i]
                    yield i + 1, page.render(scale=PDF_DPI / 72).to_pil().convert("RGB")
            finally:
                pdf.close()
            return
        try:
            img = Image.open(io.BytesIO(data))
            img = ImageOps.exif_transpose(img).convert("RGB")
        except Exception as exc:  # noqa: BLE001
            raise BadInput(f"not a readable image: {type(exc).__name__}") from exc
        yield 1, img

    # -- OCR ----------------------------------------------------------------------------------------
    def _run(self, arr):
        """Returns [(text, conf, [x1, y1, x2, y2])] in the coordinates of `arr`."""
        out = []
        with self.lock:
            if self.major >= 3:
                for res in self.ocr.predict(arr):
                    r = res.json.get("res", res) if hasattr(res, "json") else res
                    texts = list(r.get("rec_texts", []))
                    scores = list(r.get("rec_scores", []))
                    boxes = r.get("rec_boxes")
                    polys = r.get("rec_polys")
                    for i, t in enumerate(texts):
                        if boxes is not None and len(boxes) > i:
                            x1, y1, x2, y2 = [float(v) for v in boxes[i]]
                        else:
                            xs = [float(p[0]) for p in polys[i]]
                            ys = [float(p[1]) for p in polys[i]]
                            x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
                        out.append((str(t), float(scores[i]) if i < len(scores) else 0.0, [x1, y1, x2, y2]))
            else:
                for page in self.ocr.ocr(arr, cls=True) or []:
                    for box, (t, conf) in page or []:
                        xs = [float(p[0]) for p in box]
                        ys = [float(p[1]) for p in box]
                        out.append((str(t), float(conf), [min(xs), min(ys), max(xs), max(ys)]))
        return out

    def read(self, data: bytes, mime: str, max_pages: int) -> list[dict]:
        import numpy as np

        pages = []
        for page_no, img in self._images(data, mime, max_pages):
            w, h = img.size
            scale = min(1.0, MAX_EDGE / max(w, h))
            work = img if scale == 1.0 else img.resize((max(1, round(w * scale)), max(1, round(h * scale))))
            arr = np.asarray(work)[:, :, ::-1].copy()     # RGB -> BGR, as PaddleOCR expects
            found = self._run(arr)
            blocks = []
            for text, conf, (x1, y1, x2, y2) in found:
                if not text.strip():
                    continue
                blocks.append({
                    "text": text.strip(),
                    "bbox": [round(x1 / scale, 1), round(y1 / scale, 1), round((x2 - x1) / scale, 1), round((y2 - y1) / scale, 1)],
                    "conf": round(max(0.0, min(1.0, conf)), 4),
                })
            assign_lines(blocks)
            lines: dict[int, list[str]] = {}
            for b in blocks:
                lines.setdefault(b["line"], []).append(b["text"])
            pages.append({
                "page_no": page_no, "width": w, "height": h,
                "text": "\n".join(" ".join(v) for _, v in sorted(lines.items())),
                "mean_confidence": round(sum(b["conf"] for b in blocks) / len(blocks), 4) if blocks else None,
                "blocks": blocks,
            })
        return pages


def assign_lines(blocks: list[dict]) -> None:
    """Sort blocks top-to-bottom, left-to-right and number the lines (vertical overlap = same line)."""
    blocks.sort(key=lambda b: (b["bbox"][1], b["bbox"][0]))
    line = 0
    current_bottom = None
    current_top = None
    for b in blocks:
        top, height = b["bbox"][1], b["bbox"][3]
        mid = top + height / 2
        if current_bottom is None or mid > current_bottom:
            line += 1
            current_top, current_bottom = top, top + height
        else:
            current_bottom = max(current_bottom, top + height)
        b["line"] = line
    blocks.sort(key=lambda b: (b["line"], b["bbox"][0]))


def make_engine():
    if ENGINE == "fake":
        return FakeEngine()
    return PaddleEngine()


# ---------------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    engine = None
    server_version = "toyam-ocr"
    sys_version = ""

    def log_message(self, fmt, *args):  # no access log with paths / clients
        pass

    def _json(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _authorised(self) -> bool:
        if not TOKEN:
            return True
        got = self.headers.get("authorization", "")
        return hmac.compare_digest(got.encode(), f"Bearer {TOKEN}".encode())

    def do_GET(self):  # noqa: N802
        if self.path in ("/health", "/healthz"):
            self._json(200, {"ok": True, "engine": self.engine.name, "engine_version": self.engine.version})
        else:
            self._json(404, {"error": "not_found"})

    def do_POST(self):  # noqa: N802
        if self.path != "/ocr":
            return self._json(404, {"error": "not_found"})
        if not self._authorised():
            return self._json(401, {"error": "unauthorised"})
        mime = (self.headers.get("content-type") or "").split(";")[0].strip().lower()
        if mime not in IMAGE_TYPES and mime != PDF_TYPE:
            return self._json(415, {"error": f"unsupported type {mime[:40]}"})
        try:
            length = int(self.headers.get("content-length") or "0")
        except ValueError:
            return self._json(400, {"error": "bad content-length"})
        if length <= 0:
            return self._json(400, {"error": "empty body"})
        if length > MAX_BYTES:
            return self._json(413, {"error": "file too large"})
        try:
            max_pages = max(1, min(200, int(self.headers.get("x-max-pages") or "10")))
        except ValueError:
            max_pages = 10
        data = self.rfile.read(length)
        t0 = time.time()
        try:
            pages = self.engine.read(data, mime, max_pages)
        except BadInput as exc:
            return self._json(422, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            log("ocr_failed", error=type(exc).__name__)
            return self._json(500, {"error": "ocr failed"})
        log("ocr_done", pages=len(pages), blocks=sum(len(p["blocks"]) for p in pages), ms=round((time.time() - t0) * 1000))
        self._json(200, {"engine": self.engine.name, "engine_version": self.engine.version, "lang": LANG, "pages": pages})


def main() -> None:
    Handler.engine = make_engine()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    log("listening", host=HOST, port=server.server_address[1], engine=Handler.engine.name, engine_version=Handler.engine.version)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

# PaddleOCR sidecar (CPU). Build from the repository root:
#   docker build -f services/pipeline/ocr-sidecar/Dockerfile -t toyam-ocr services/pipeline/ocr-sidecar
# Runs next to the pipeline worker (same host / pod); the worker calls http://<host>:8866/ocr.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 \
    HOST=0.0.0.0 PORT=8866 OCR_LANG=en

# OpenCV (a PaddleOCR dependency) needs these shared libraries even headless
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libgomp1 \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 ocr
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt

USER ocr
# Download the detection / recognition models at build time, so the container starts without network access
RUN python -c "import os; from paddleocr import PaddleOCR; PaddleOCR(lang=os.environ['OCR_LANG'], use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=True)"

COPY app.py .
EXPOSE 8866
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8866/health', timeout=4).status == 200 else 1)"
CMD ["python", "app.py"]

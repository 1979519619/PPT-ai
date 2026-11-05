# Local OCR runtime provenance

PPT-ai's local screenshot text extraction uses a separately prepared Windows x64 CPU runtime. The adapter and worker in `app/m1` are project code; the following upstream components retain their original licenses. This note is provenance, not a claim that software integration tests have passed.

- CPython 3.12.10 Windows embeddable distribution: Python Software Foundation license and included third-party notices. Source/download: https://www.python.org/downloads/release/python-31210/ . The installer verifies the archive SHA256 published in python.org's corresponding Sigstore bundle and retains Python's LICENSE.txt.
- RapidOCR 3.9.2: Apache-2.0. Source: https://github.com/RapidAI/RapidOCR . PyPI artifact: https://pypi.org/project/rapidocr/3.9.2/ . The local adapter uses explicit model paths and disables all automatic downloads.
- ONNX Runtime 1.23.2 CPU: MIT. Source: https://github.com/microsoft/onnxruntime/tree/v1.23.2 . Package: https://pypi.org/project/onnxruntime/1.23.2/ . No CUDA, DirectML, or other GPU backend is selected.
- PP-OCRv4 Chinese/English mobile detection and recognition models, plus PP-OCR mobile text orientation classifier: PaddleOCR project, Apache-2.0. Source: https://github.com/PaddlePaddle/PaddleOCR . ONNX conversions and SHA256 values: https://github.com/RapidAI/RapidOCR/blob/v3.9.2/python/rapidocr/default_models.yaml . The preparation script prefers the same byte-identical files in maintainer SWHL's Hugging Face repository, fixed to commit `1cfba2e90fc938db55889873735088de210cc173`: https://huggingface.co/SWHL/RapidOCR/tree/1cfba2e90fc938db55889873735088de210cc173 . Their LFS SHA256 values match the RapidOCR catalog. ModelScope remains the fallback; each candidate download is bounded to 90 seconds and at most two sources are attempted per file. Actual hashes and download URLs are recorded in `ocr-runtime/runtime-manifest.json` after preparation. The fallback recognition dictionary is the PP-OCRv4 `ppocr_keys_v1.txt`, fixed to PaddleOCR v2.7.0 or the byte-identical official RapidAI ModelScope v2.0.7 copy.

`app/m1/ocr-requirements.txt` pins runtime dependencies. They include NumPy, OpenCV, Pillow, Shapely, PyClipper, OmegaConf/ANTLR, PyYAML, requests and ONNX Runtime's supporting libraries. Preparation copies the installed packages' license, notice and authors files into `ocr-runtime/licenses/packages` and records each installed distribution's declared license fields in its manifest. Keep this entire licenses directory with packaged runtime resources; do not replace third-party licenses with PPT-ai's own project license.

Preparation uses pinned pip, setuptools and wheel solely as local installation tools. The default preparation writes downloads, package staging and temporary files under this project's F-drive directories. The explicit `-AllowCiWorkspace` exception is restricted to GitHub Actions and paths inside `GITHUB_WORKSPACE`. Dependency reuse inspects installed METADATA versions only and does not import packages or prove runtime correctness. The embedded Python path configuration excludes global/user Python packages. Images, recognized text and translations are not recorded by the worker; selected image crops are passed in memory via stdin and results via stdout. The worker's network calls are blocked and missing or altered local models produce an explicit resource error.

Relevant official API/source references:

- https://rapidai.github.io/RapidOCRDocs/v3.4.1/install_usage/rapidocr/usage/
- https://github.com/RapidAI/RapidOCR/blob/v3.9.2/python/rapidocr/main.py
- https://github.com/RapidAI/RapidOCR/blob/v3.9.2/python/rapidocr/utils/parse_parameters.py
- https://github.com/RapidAI/RapidOCR/blob/v3.9.2/python/rapidocr/inference_engine/onnxruntime/main.py

The documents describe library capabilities. Runtime performance, OCR quality, WPS/PowerPoint behavior and classroom acceptance remain user-run checks.

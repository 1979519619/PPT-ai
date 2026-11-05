"""One-shot CPU OCR worker. No files containing screenshots or text are created."""
import base64
import contextlib
import hashlib
import io
import json
import math
import os
from pathlib import Path
import socket
import sys

MAX_INPUT = 48 * 1024 * 1024
STAGE = "verify-resources"
MODELS = {
    "ch_PP-OCRv4_det_mobile.onnx": "d2a7720d45a54257208b1e13e36a8479894cb74155a5efe29462512d42f49da9",
    "ch_PP-OCRv4_rec_mobile.onnx": "48fc40f24f6d2a207a2b1091d3437eb3cc3eb6b676dc3ef9c37384005483683b",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx": "e47acedf663230f8863ff1ab0e64dd2d82b838fceb5957146dab185a89d6215c",
    "ppocr_keys_v1.txt": "28b2362ad4ab2dc38769aa72feb535e3a9ddb3fd2a7585a05920e6393b1dc7f7",
}


def deny_network(*_args, **_kwargs):
    raise RuntimeError("本地识别禁止联网或自动下载资源")


def run():
    global STAGE
    runtime = Path(sys.argv[1]).resolve()
    model_dir = runtime / "models"
    for name, expected in MODELS.items():
        candidate = model_dir / name
        if not candidate.is_file():
            raise RuntimeError("本地识别模型缺失，请重新准备资源")
        with candidate.open("rb") as source:
            actual = hashlib.file_digest(source, "sha256").hexdigest()
        if actual != expected:
            raise RuntimeError("本地识别模型校验失败，请重新准备资源")

    # Explicit local models plus a hard download/network prohibition protect
    # offline startup even if an upstream default changes in a future build.
    socket.create_connection = deny_network
    socket.socket.connect = deny_network
    socket.socket.connect_ex = deny_network
    STAGE = "load-runtime"
    from rapidocr import EngineType, ModelType, OCRVersion, RapidOCR
    from rapidocr.utils.download_file import DownloadFile
    DownloadFile.run = staticmethod(deny_network)
    import onnxruntime
    onnxruntime.disable_telemetry_events()
    import cv2
    import numpy as np

    params = {
        "Global.log_level": "critical",
        "Global.model_root_dir": str(model_dir),
        "Global.text_score": 0.45,
        "Global.max_side_len": 4096,
        "Global.return_word_box": False,
        "EngineConfig.onnxruntime.intra_op_num_threads": 4,
        "EngineConfig.onnxruntime.inter_op_num_threads": 1,
        "EngineConfig.onnxruntime.use_cuda": False,
        "EngineConfig.onnxruntime.use_dml": False,
        "EngineConfig.onnxruntime.use_cann": False,
        "EngineConfig.onnxruntime.use_coreml": False,
        "Det.model_path": str(model_dir / "ch_PP-OCRv4_det_mobile.onnx"),
        "Cls.model_path": str(model_dir / "ch_ppocr_mobile_v2.0_cls_mobile.onnx"),
        "Rec.model_path": str(model_dir / "ch_PP-OCRv4_rec_mobile.onnx"),
        "Rec.rec_keys_path": str(model_dir / "ppocr_keys_v1.txt"),
    }
    for section in ("Det", "Cls", "Rec"):
        params[f"{section}.engine_type"] = EngineType.ONNXRUNTIME
        params[f"{section}.model_type"] = ModelType.MOBILE
        params[f"{section}.ocr_version"] = OCRVersion.PPOCRV4
    STAGE = "initialize-engine"
    engine = RapidOCR(params=params)

    STAGE = "read-input"
    raw = sys.stdin.buffer.read(MAX_INPUT + 1)
    if len(raw) > MAX_INPUT:
        raise RuntimeError("本地识别输入过大")
    payload = json.loads(raw)
    if payload.get("version") != 1 or not isinstance(payload.get("regions"), list) or len(payload["regions"]) > 5:
        raise RuntimeError("本地识别输入格式异常")
    results = []
    for region in payload["regions"]:
        identifier = str(region.get("id", ""))
        try:
            encoded = region.get("png")
            if not isinstance(encoded, str):
                raise ValueError("bad image")
            image_bytes = base64.b64decode(encoded, validate=True)
            # Decode only the in-memory selected crop. cv2's BGR ndarray is the
            # documented RapidOCR input, avoiding file/network image loaders.
            image = cv2.imdecode(np.frombuffer(image_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
            if image is None or image.size == 0 or image.shape[0] * image.shape[1] > 40 * 1024 * 1024:
                raise ValueError("bad image dimensions")
            output = engine(image)
            boxes, texts, scores = output.boxes, output.txts, output.scores
            lines = []
            if boxes is not None and texts is not None and scores is not None:
                if len(boxes) != len(texts) or len(texts) != len(scores) or len(texts) > 600:
                    raise ValueError("incomplete or excessive OCR result")
                for box, text, score in zip(boxes, texts, scores):
                    points = [[float(point[0]), float(point[1])] for point in box]
                    confidence = float(score)
                    if len(points) != 4 or not all(math.isfinite(value) for point in points for value in point) or not math.isfinite(confidence):
                        continue
                    text = str(text).strip()
                    if text:
                        lines.append({"box": points, "text": text, "confidence": confidence})
            results.append({"id": identifier, "lines": lines})
        except Exception:
            results.append({"id": identifier, "lines": [], "error": "该选区无法识别，请重新圈选或校正原文"})
    return {"ok": True, "regions": results}


if __name__ == "__main__":
    # Some third-party code writes diagnostics to stdout. Keep the protocol
    # separate and suppress upstream output rather than persisting it.
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            response = run()
        exit_code = 0
    except Exception:
        response = {"ok": False, "code": "ocr-" + STAGE, "error": "本地文字识别组件无法初始化，请检查资源是否完整"}
        exit_code = 1
    sys.stdout.buffer.write(json.dumps(response, ensure_ascii=False, allow_nan=False).encode("utf-8"))
    sys.stdout.buffer.flush()
    raise SystemExit(exit_code)

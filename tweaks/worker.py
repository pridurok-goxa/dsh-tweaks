#!/usr/bin/env python3
"""Whisper (faster-whisper) recognition worker for the DSH speech-to-text seam.

Protocol: newline-delimited JSON on stdin/stdout, one command at a time.

  in : {"id": "1", "cmd": "prepare", "model": "medium", "downloadRoot": "/path",
        "downloadSource": "https://huggingface.co", "device": "cpu",
        "computeType": "int8", "threads": 4}
  in : {"id": "2", "cmd": "transcribe", "path": "/tmp/x.wav", "language": "ru", "beamSize": 5}
  in : {"id": "3", "cmd": "release"}
  in : {"id": "4", "cmd": "shutdown"}

  out: {"id": "1", "ok": true, "result": {...}}
  out: {"id": "1", "ok": false, "error": "...", "failure": {...}}
  out: {"event": "progress", "resource": "model", "completedBytes": 1, "totalBytes": 2}
"""

from __future__ import annotations

import json
import os
import sys
import threading
import time
import wave

import numpy as np


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def log(message: str, level: str = "info") -> None:
    emit({"event": "log", "level": level, "message": message})


def repo_for(model: str) -> str:
    """Map a model alias to its Hugging Face repository."""
    if "/" in model:
        return model
    try:
        from faster_whisper.utils import _MODELS  # type: ignore[attr-defined]

        if model in _MODELS:
            return _MODELS[model]
    except Exception:  # pragma: no cover - alias table is optional
        pass
    return f"Systran/faster-whisper-{model}"


def directory_bytes(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def read_wav(path: str) -> np.ndarray:
    """Decode one canonical WAV into 16 kHz mono float32 samples."""
    with wave.open(path, "rb") as handle:
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        rate = handle.getframerate()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError(f"unsupported sample width {width * 8} bit; expected 16-bit PCM")
    samples = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        length = int(round(len(samples) * 16000 / rate))
        if length <= 0:
            return np.zeros(0, dtype=np.float32)
        source = np.linspace(0.0, 1.0, num=len(samples), endpoint=False)
        target = np.linspace(0.0, 1.0, num=length, endpoint=False)
        samples = np.interp(target, source, samples).astype(np.float32)
    return samples


class Worker:
    def __init__(self) -> None:
        self.model = None
        self.model_key = None
        self.lock = threading.Lock()

    # -- preparation -----------------------------------------------------
    def prepare(self, request: dict) -> dict:
        model = str(request.get("model") or "medium")
        download_root = str(request.get("downloadRoot") or "")
        source = str(request.get("downloadSource") or "").strip()
        device = str(request.get("device") or "cpu")
        compute_type = str(request.get("computeType") or "int8")
        threads = int(request.get("threads") or 0)

        os.makedirs(download_root, exist_ok=True)
        if source:
            os.environ["HF_ENDPOINT"] = source
        os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
        os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")

        repo = repo_for(model)
        local_dir = os.path.join(download_root, "models", model.replace("/", "__"))

        with self.lock:
            if self.model is not None and self.model_key == model:
                return {"model": model, "repo": repo, "cached": True, "loadSeconds": 0.0}

            download_seconds = 0.0
            if not os.path.exists(os.path.join(local_dir, "model.bin")):
                download_seconds = self._download(repo, local_dir)
            else:
                log(f"model {model} present in {local_dir}, skipping download")

            started = time.time()
            loaded, effective = self._load(local_dir, device, compute_type, threads)
            self.model = loaded
            self.model_key = model
            self._warmup()
            return {
                "model": model,
                "repo": repo,
                "cached": download_seconds == 0.0,
                "downloadSeconds": round(download_seconds, 3),
                "loadSeconds": round(time.time() - started, 3),
                "directory": local_dir,
                "device": effective["device"],
                "computeType": effective["computeType"],
                **({"fallbackFrom": effective["fallbackFrom"]} if effective.get("fallbackFrom") else {}),
            }

    def _load(self, local_dir: str, device: str, compute_type: str, threads: int):
        """Load weights, falling back to CPU when an accelerator or its libraries are missing.

        `device: auto` tries CUDA first and drops to CPU; an explicit GPU device also
        falls back rather than leaving the provider unusable on a machine without the
        CUDA runtime (the usual Windows case). CPU loads never fall back further.
        """
        from faster_whisper import WhisperModel

        if device == "cpu":
            candidates = ["cpu"]
        elif device == "auto":
            candidates = ["cuda", "cpu"]
        else:
            candidates = [device, "cpu"]

        failure = None
        for index, candidate in enumerate(candidates):
            kind = compute_type
            if candidate == "cpu" and compute_type in ("default", ""):
                kind = "int8"
            elif candidate == "cpu" and compute_type not in ("int8", "int8_float32", "float32", "int16"):
                kind = "int8"
            try:
                model = WhisperModel(
                    local_dir,
                    device=candidate,
                    compute_type=kind,
                    cpu_threads=threads,
                    local_files_only=True,
                )
                if candidate == "cuda":
                    # CTranslate2 initialises CUDA lazily: cuBLAS/cuDNN load on the
                    # first inference, not on construction. Force one eager pass so
                    # a machine with an NVIDIA GPU but missing cuBLAS/cuDNN falls
                    # back to CPU here instead of hanging on the first transcribe.
                    silence = np.zeros(16000, dtype=np.float32)
                    list(model.transcribe(silence, language="en", beam_size=1, vad_filter=False)[0])
                if index > 0:
                    log(f"{device} unavailable ({failure}); falling back to {candidate}/{kind}", "warn")
                return model, {
                    "device": candidate,
                    "computeType": kind,
                    "fallbackFrom": device if index > 0 else None,
                }
            except Exception as error:  # missing driver, cuBLAS/cuDNN, unsupported compute type
                failure = f"{type(error).__name__}: {error}"
                if candidate == "cpu":
                    raise
        raise RuntimeError(f"no usable device: {failure}")

    def _download(self, repo: str, local_dir: str) -> float:
        from huggingface_hub import snapshot_download

        total = None
        try:
            from huggingface_hub import HfApi

            info = HfApi().model_info(repo, files_metadata=True)
            if info.siblings:
                total = sum(int(file.size or 0) for file in info.siblings)
        except Exception as error:  # progress stays best-effort
            log(f"model size probe failed: {error}", "warn")

        os.makedirs(local_dir, exist_ok=True)
        stop = threading.Event()
        started = time.time()

        def poll() -> None:
            while not stop.wait(0.5):
                payload = {
                    "event": "progress",
                    "resource": "model",
                    "completedBytes": directory_bytes(local_dir),
                }
                if total:
                    payload["totalBytes"] = total
                emit(payload)

        thread = threading.Thread(target=poll, daemon=True)
        thread.start()
        try:
            snapshot_download(repo_id=repo, local_dir=local_dir)
        finally:
            stop.set()
        emit({"event": "progress", "resource": "model", "completedBytes": directory_bytes(local_dir), **({"totalBytes": total} if total else {})})
        return time.time() - started

    def _warmup(self) -> None:
        """Load native weights once so the first real request is not penalized."""
        try:
            silence = np.zeros(16000, dtype=np.float32)
            list(self.model.transcribe(silence, language="en", beam_size=1, vad_filter=False)[0])
        except Exception as error:  # warm-up never fails preparation
            log(f"warm-up skipped: {error}", "warn")

    # -- inference -------------------------------------------------------
    def transcribe(self, request: dict) -> dict:
        with self.lock:
            if self.model is None:
                raise RuntimeError("model is not loaded; run prepare first")
            path = str(request.get("path") or "")
            language = str(request.get("language") or "auto")
            beam = int(request.get("beamSize") or 5)
            audio = read_wav(path)
            audio_seconds = float(len(audio)) / 16000.0
            started = time.time()
            segments, info = self.model.transcribe(
                audio,
                language=None if language in ("auto", "") else language,
                beam_size=beam,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            parts = []
            for segment in segments:
                text = segment.text.strip()
                if text:
                    parts.append(text)
            text = " ".join(parts).strip()
            return {
                "text": text,
                "audioSeconds": round(float(getattr(info, "duration", audio_seconds)), 3),
                "inferenceSeconds": round(time.time() - started, 3),
                "language": getattr(info, "language", None),
            }

    def release(self) -> dict:
        with self.lock:
            self.model = None
            self.model_key = None
        return {"released": True}


def classify(error: Exception, request: dict) -> dict:
    """Report a download-shaped failure the UI can explain."""
    text = str(error)
    reason = "unknown"
    markers = (
        ("network", ("Connection", "ECONN", "ENETUNREACH", "EHOSTUNREACH", "timed out", "Timeout")),
        ("dns", ("Name or service not known", "getaddrinfo", "ENOTFOUND")),
        ("certificate", ("certificate", "SSL", "CERT_")),
        ("integrity", ("hash", "checksum", "size mismatch")),
        ("storage", ("No space", "Permission denied", "Read-only")),
    )
    for name, needles in markers:
        if any(needle in text for needle in needles):
            reason = name
            break
    failure = {
        "resource": "model",
        "source": os.environ.get("HF_ENDPOINT", "https://huggingface.co"),
        "reason": reason,
    }
    if request.get("downloadSource"):
        failure["source"] = str(request["downloadSource"])
    return failure


def main() -> None:
    current: dict = {}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as error:
            emit({"id": None, "ok": False, "error": f"invalid request: {error}"})
            continue
        command = request.get("cmd")
        request_id = request.get("id")
        if command == "shutdown":
            emit({"id": request_id, "ok": True, "result": {"stopped": True}})
            return
        current = request
        try:
            if command == "prepare":
                result = WORKER.prepare(request)
            elif command == "transcribe":
                result = WORKER.transcribe(request)
            elif command == "release":
                result = WORKER.release()
            elif command == "ping":
                result = {"pong": True}
            else:
                raise ValueError(f"unknown command {command!r}")
            emit({"id": request_id, "ok": True, "result": result})
        except Exception as error:  # one failed command never kills the worker
            payload = {"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"}
            if command == "prepare":
                payload["failure"] = classify(error, current)
            emit(payload)


WORKER = Worker()

if __name__ == "__main__":
    main()

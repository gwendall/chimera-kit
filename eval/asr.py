#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.12,<3.14"
# dependencies = [
#   "numpy>=2,<3",
#   "soundfile==0.14.0",
#   "soxr==1.1.0",
#   "onnx-asr[cpu,hub]==0.12.0",
#   "mlx-whisper==0.4.3; sys_platform == 'darwin'",
# ]
# ///
"""Transcribes a list of WAV files with one speech recognizer. Deterministic for a given audio.

usage: asr.py <parakeet|whisper> <manifest.json> <out.json>

manifest.json is [{"key": ..., "path": ...}]; out.json is {key: transcript}.

parakeet  NVIDIA Parakeet TDT 0.6b v3, int8 ONNX. Set PARAKEET_DIR to a folder holding the model,
          or it uses Handy's copy when present, or downloads it.
whisper   Whisper large-v3-turbo through MLX (macOS). The independent referee: a different
          architecture and training set from Parakeet, so gains that only fool one don't count.
"""

import json
import os
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

HANDY = Path.home() / "Library/Application Support/com.pais.handy/models/parakeet-tdt-0.6b-v3-int8"
RATE = 16_000


def audio(path):
    samples, rate = sf.read(path, dtype="float32", always_2d=True)
    return soxr.resample(samples.mean(axis=1), rate, RATE, quality="VHQ").astype(np.float32)


def clean_model_dir(source):
    """A folder of links to the model files, leaving out macOS's `._*` sidecars, which confuse globs."""
    target = Path(tempfile.mkdtemp(prefix="parakeet-"))
    for item in source.iterdir():
        if not item.name.startswith("._"):
            (target / item.name).symlink_to(item)
    return target


def parakeet(items):
    import onnx_asr

    configured = os.environ.get("PARAKEET_DIR")
    source = Path(configured) if configured else HANDY if HANDY.exists() else None
    path = str(clean_model_dir(source)) if source else None
    model = onnx_asr.load_model("nemo-parakeet-tdt-0.6b-v3", path, quantization="int8")
    return {key: model.recognize(audio(file), sample_rate=RATE) for key, file in items}


def whisper(items):
    import mlx_whisper

    options = {
        "path_or_hf_repo": "mlx-community/whisper-large-v3-turbo",
        "language": "en",
        "temperature": 0.0,
        "condition_on_previous_text": False,
        "verbose": None,
    }
    return {key: mlx_whisper.transcribe(audio(file), **options)["text"].strip() for key, file in items}


def main():
    backend, manifest, out = sys.argv[1:4]
    items = [(entry["key"], entry["path"]) for entry in json.loads(Path(manifest).read_text())]
    result = {"parakeet": parakeet, "whisper": whisper}[backend](items)
    Path(out).write_text(json.dumps(result, ensure_ascii=False, indent=0))


if __name__ == "__main__":
    main()

"""Renders the narration of video/script.json with Kokoro (offline, Apache-2.0) and records each segment's length.

Usage: <venv>/python video/tts.py [--voice af_heart] [--models <dir with kokoro-v1.0.onnx + voices-v1.0.bin>]
Writes video/out/vo/<segment>.wav and video/out/vo/durations.json (seconds, incl. a short tail pause).
"""
import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent
TAIL_PAUSE_S = 0.6  # breathing room after each segment


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice")
    parser.add_argument("--models", default=str(Path.home() / "tools" / "kokoro"))
    args = parser.parse_args()

    script = json.loads((ROOT / "script.json").read_text(encoding="utf-8"))
    voice = args.voice or script["voice"]
    models = Path(args.models)
    kokoro = Kokoro(str(models / "kokoro-v1.0.onnx"), str(models / "voices-v1.0.bin"))

    out = ROOT / "out" / "vo"
    out.mkdir(parents=True, exist_ok=True)
    durations = {}
    for segment in script["segments"]:
        samples, rate = kokoro.create(segment["text"], voice=voice, speed=script["speed"], lang="en-us")
        padded = np.concatenate([samples, np.zeros(int(rate * TAIL_PAUSE_S), dtype=samples.dtype)])
        sf.write(out / f"{segment['id']}.wav", padded, rate)
        durations[segment["id"]] = round(len(padded) / rate, 3)
        print(f"{segment['id']}: {durations[segment['id']]:.2f}s")

    (out / "durations.json").write_text(json.dumps(durations, indent=2) + "\n", encoding="utf-8")
    print(f"total narration: {sum(durations.values()):.1f}s")


if __name__ == "__main__":
    main()

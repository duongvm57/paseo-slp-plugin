#!/usr/bin/env python3
"""Local OmniVoice (k2-fsa) narration driver for build.py's `command` TTS backend.

Run it with the Python interpreter of an OmniVoice environment. The model is loaded once
per invocation and every item runs sequentially (one inference at a time).

  design  synthesize a reference sample with voice design (`--instruct`), save WAV + text
  prompt  turn a reference WAV + its exact text into a reusable VoiceClonePrompt (.pt)
  batch   synthesize every job in a JSONL file ({"text", "out", "language"}) with that prompt

The narrator voice is synthetic: a voice-design sample made by this script, then reused as
the clone prompt so every sentence keeps the same speaker. No third-party voice is cloned.
Seeds derive from the text, so the same input gives the same audio on the same setup.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path


def seed_for(text: str, base: int) -> int:
    return (int(hashlib.sha256(text.encode()).hexdigest()[:8], 16) + base) % (2**31)


def load_model(model_dir: str, device: str, dtype_name: str):
    import torch
    from omnivoice import OmniVoice

    dtype = {"float32": torch.float32, "bfloat16": torch.bfloat16, "float16": torch.float16}[dtype_name]
    t0 = time.time()
    model = OmniVoice.from_pretrained(model_dir, device_map=device, dtype=dtype)
    print(f"[omnivoice] model loaded in {time.time() - t0:.1f}s on {device} ({dtype_name})", flush=True)
    return model


def write_wav(path: Path, audio, sr: int):
    import soundfile as sf

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp.wav")
    sf.write(str(tmp), audio, sr)
    tmp.replace(path)


def gen(model, seed: int, **kw):
    import torch

    torch.manual_seed(seed)
    t0 = time.time()
    audio = model.generate(**kw)[0]
    dur = len(audio) / model.sampling_rate
    return audio, dur, time.time() - t0


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("mode", choices=["design", "prompt", "batch"])
    ap.add_argument("--model", required=True, help="local OmniVoice model directory")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--dtype", default="float32", choices=["float32", "bfloat16", "float16"])
    ap.add_argument("--language", help="language code, e.g. vi or en")
    ap.add_argument("--instruct", default="male, middle-aged, low pitch")
    ap.add_argument("--text", help="text for design mode, or the reference text for prompt mode")
    ap.add_argument("--ref", type=Path, help="reference WAV (prompt mode)")
    ap.add_argument("--voice-prompt", type=Path, help="VoiceClonePrompt .pt (batch mode output/input)")
    ap.add_argument("--jobs", type=Path, help="JSONL jobs (batch mode)")
    ap.add_argument("--out", type=Path, help="output path (design: WAV; prompt: .pt)")
    ap.add_argument("--seed", type=int, default=20261005)
    ap.add_argument("--num-step", type=int, default=32)
    ap.add_argument("--speed", type=float, default=None)
    a = ap.parse_args()

    model = load_model(a.model, a.device, a.dtype)
    sr = model.sampling_rate

    if a.mode == "design":
        audio, dur, el = gen(model, a.seed, text=a.text, language=a.language, instruct=a.instruct,
                             num_step=a.num_step, speed=a.speed)
        write_wav(a.out, audio, sr)
        a.out.with_suffix(".json").write_text(json.dumps(
            {"mode": "voice-design", "instruct": a.instruct, "language": a.language, "seed": a.seed,
             "numStep": a.num_step, "text": a.text, "seconds": round(dur, 3), "rtf": round(el / max(dur, 1e-6), 3)},
            ensure_ascii=False, indent=1))
        print(f"[omnivoice] design: {dur:.2f}s audio in {el:.1f}s -> {a.out}", flush=True)
        return

    if a.mode == "prompt":
        from omnivoice import VoiceClonePrompt  # noqa: F401  (import check)

        prompt = model.create_voice_clone_prompt(ref_audio=str(a.ref), ref_text=a.text)
        a.out.parent.mkdir(parents=True, exist_ok=True)
        prompt.save(str(a.out))
        print(f"[omnivoice] prompt saved -> {a.out}", flush=True)
        return

    from omnivoice import VoiceClonePrompt

    prompt = VoiceClonePrompt.load(str(a.voice_prompt))
    jobs = [json.loads(line) for line in a.jobs.read_text(encoding="utf-8").splitlines() if line.strip()]
    total_audio = total_time = 0.0
    for i, job in enumerate(jobs, 1):
        out = Path(job["out"])
        if out.exists():
            continue
        audio, dur, el = gen(model, seed_for(job["text"], job.get("seed", a.seed)), text=job["text"],
                             language=job.get("language") or a.language, voice_clone_prompt=prompt,
                             num_step=a.num_step, speed=a.speed)
        write_wav(out, audio, sr)
        total_audio += dur
        total_time += el
        print(f"[omnivoice] {i}/{len(jobs)} {dur:.2f}s in {el:.1f}s -> {out.name}", flush=True)
    if total_audio:
        print(f"[omnivoice] batch: {total_audio:.1f}s audio in {total_time:.1f}s (RTF {total_time / total_audio:.2f})")


if __name__ == "__main__":
    sys.exit(main())

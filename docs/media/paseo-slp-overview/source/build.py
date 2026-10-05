#!/usr/bin/env python3
"""Reproducible bilingual renderer for docs/media/paseo-slp-overview.

Each language has its own narration script (script.json = English,
script.vi.json = Vietnamese), timeline, captions and poster. Steps:

  plan      print the exact characters each scene would send to TTS (no network)
  quota     print the ElevenLabs character usage of the configured account
  tts       synthesize one coherent passage per scene (cached; never re-sent)
  timeline  derive cue timing from the audio, write timeline.<lang>.json + VTT
  lint      list visible stage strings that have no translation
  stills    render selected frames to PNG for review
  render    render every frame of stage.html with headless Chrome (Playwright)
  encode    mux frames + narration into <work>/final/paseo-slp-overview.<lang>.mp4
  poster    write poster.<lang>.jpg
  all       tts, timeline, render, encode and poster

TTS backends (--tts):
  elevenlabs  ElevenLabs text-to-speech. The API key is read from the file named by
              SLP_ELEVENLABS_KEY_FILE (default ~/.local/state/paseo-slp/private/elevenlabs.key).
              The key never appears in arguments, logs or outputs.
  import      use audio files that already exist: <audio-dir>/<lang>/<scene-id>.mp3|wav
  silent      no narration; timing estimated from the text (layout previews)

Requirements: Python 3.10+, playwright (Python) with a Chrome/Chromium binary
(SLP_VIDEO_CHROME), Pillow, ffmpeg/ffprobe.
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import wave
from array import array
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
MEDIA = HERE.parent
REPO = MEDIA.parents[2]
STAGE = HERE / "stage.html"
SCRIPTS = {"en": HERE / "script.json", "vi": HERE / "script.vi.json"}

FPS = 30
SAMPLE_RATE = 44100
LEAD, TAIL = 0.8, 1.1
TITLE_LEAD, LAST_TAIL = 1.6, 3.5
SILENT_CPS = 14.0  # characters per second used for silent timing estimates
API = "https://api.elevenlabs.io/v1"
DEFAULT_KEY_FILE = Path.home() / ".local/state/paseo-slp/private/elevenlabs.key"
MAX_MP4_BYTES = 9_500_000


def log(*a):
    print("[build]", *a, flush=True)


def run(cmd, **kw):
    log("$", " ".join(str(c) for c in cmd))
    return subprocess.run(cmd, check=True, **kw)


def load_script(lang):
    return json.loads(SCRIPTS[lang].read_text(encoding="utf-8"))


VOICE = None  # selected voice profile name (--voice); None = the script's defaultVoice


def voice_of(sc):
    name = VOICE or sc["defaultVoice"]
    return name, sc["voices"][name]


def paths(work: Path, lang: str):
    sc = load_script(lang)
    name, _ = voice_of(sc)
    # The ElevenLabs preview keeps its original cache layout; other voices get their own trees.
    legacy = name == "elevenlabs"
    base = work / lang if legacy else work / name / lang
    return {
        "timeline": HERE / f"timeline.{lang}.json",
        "vtt": MEDIA / f"paseo-slp-overview.{lang}.vtt",
        "poster": MEDIA / f"poster.{lang}.jpg",
        "mp4": work / ("preview-elevenlabs" if legacy else "final") / f"paseo-slp-overview.{lang}.mp4",
        "tts": work / "tts" / lang if legacy else work / f"tts-{name}" / lang,
        "frames": base / "frames",
        "audio": base / "narration.wav",
        "stills": base / "stills",
    }


def spoken(cue, pron):
    text = cue.get("say", cue["text"])
    for word, say in pron.items():
        text = re.sub(rf"(?<!\w){re.escape(word)}(?!\w)", say, text)
    return text


def scene_passage(scene, pron):
    """One coherent passage per scene, plus each cue's character span inside it."""
    parts, spans, pos = [], [], 0
    for cue in scene["cues"]:
        s = spoken(cue, pron)
        if parts:
            pos += 1
        spans.append((pos, pos + len(s)))
        parts.append(s)
        pos += len(s)
    return " ".join(parts), spans


def tts_key(voice, text, endpoint):
    fields = {"model": voice["model"], "voice": voice.get("voiceId"), "lang": voice["languageCode"],
              "settings": voice["settings"], "format": voice["outputFormat"], "endpoint": endpoint, "text": text}
    if voice["backend"] != "elevenlabs":
        fields.update(instruct=voice.get("instruct"), reference=voice.get("reference"))
    blob = json.dumps(fields, sort_keys=True, ensure_ascii=False)
    return hashlib.sha256(blob.encode()).hexdigest()[:16]


# ---------------------------------------------------------------- TTS ------
def cached_scene(tdir: Path, scene_id: str):
    meta = sorted(tdir.glob(f"{scene_id}-*.json"))
    return meta


def find_cache(tdir: Path, scene_id: str, voice, text):
    for endpoint in ("with-timestamps", "plain", "history", "command"):
        k = tts_key(voice, text, endpoint)
        m = tdir / f"{scene_id}-{k}.json"
        if m.exists():
            audio = json.loads(m.read_text(encoding="utf-8")).get("audio") or f"{scene_id}-{k}.mp3"
            if (tdir / audio).exists():
                return m
    return None


def scene_audio(meta_p: Path):
    meta = json.loads(meta_p.read_text(encoding="utf-8"))
    return meta_p.parent / (meta.get("audio") or meta_p.with_suffix(".mp3").name)


def read_key():
    p = Path(os.environ.get("SLP_ELEVENLABS_KEY_FILE", DEFAULT_KEY_FILE))
    key = p.read_text(encoding="utf-8").strip()
    if not key:
        sys.exit("tts: empty key file")
    return key


def http(method, url, key, body=None, timeout=180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("xi-api-key", key)
    req.add_header("Accept", "application/json" if "with-timestamps" in url or method == "GET" else "audio/mpeg")
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        detail = e.read()[:600].decode("utf-8", "replace").replace(key, "[REDACTED]")
        return e.code, detail.encode()
    except urllib.error.URLError as e:
        return 0, str(e.reason).replace(key, "[REDACTED]").encode()


def step_quota():
    status, body = http("GET", f"{API}/user/subscription", read_key(), timeout=30)
    if status != 200:
        sys.exit(f"quota: HTTP {status}")
    s = json.loads(body)
    out = {k: s.get(k) for k in ("tier", "character_count", "character_limit", "next_character_count_reset_unix")}
    print(json.dumps(out))
    return out


def ledger_path(work: Path):
    return work / "tts" / "ledger.json"


def load_ledger(work: Path):
    p = ledger_path(work)
    return json.loads(p.read_text()) if p.exists() else {"sentChars": 0, "requests": []}


def save_ledger(work: Path, led):
    ledger_path(work).parent.mkdir(parents=True, exist_ok=True)
    ledger_path(work).write_text(json.dumps(led, indent=1, ensure_ascii=False) + "\n")


def step_plan(langs):
    total = 0
    for lang in langs:
        sc = load_script(lang)
        rows = [(s["id"], len(scene_passage(s, sc["pronunciation"])[0])) for s in sc["scenes"]]
        n = sum(c for _, c in rows)
        total += n
        log(f"plan {lang}: {n} chars in {len(rows)} passages; " + ", ".join(f"{i}={c}" for i, c in rows))
    log(f"plan total: {total} chars")
    return total


def step_recover(work: Path, lang: str, scene_id: str, history_id: str):
    """Recover a passage whose response was lost, from the account's generation history.

    Downloading an existing history item does not synthesize again. The item must match the
    passage text (or, when the API omits text, its exact character count and model)."""
    sc = load_script(lang)
    _, voice = voice_of(sc)
    if voice["backend"] != "elevenlabs":
        sys.exit("recover: only the ElevenLabs profile has a remote history")
    scene = next(s for s in sc["scenes"] if s["id"] == scene_id)
    text, _ = scene_passage(scene, sc["pronunciation"])
    tdir = paths(work, lang)["tts"]
    if find_cache(tdir, scene_id, voice, text):
        log(f"recover {lang}/{scene_id}: already cached")
        return
    key = read_key()
    status, body = http("GET", f"{API}/history/{history_id}", key, timeout=30)
    if status != 200:
        sys.exit(f"recover: history item HTTP {status}")
    item = json.loads(body)
    used = (item.get("character_count_change_to") or 0) - (item.get("character_count_change_from") or 0)
    if item.get("text"):
        if item["text"] != text:
            sys.exit("recover: history text differs from the passage")
        match = "text"
    elif used == len(text) and item.get("model_id") == voice["model"]:
        match = "characterCount+model"
    else:
        sys.exit(f"recover: history item does not match ({used} chars vs {len(text)})")
    status, audio = http("GET", f"{API}/history/{history_id}/audio", key, timeout=120)
    if status != 200:
        sys.exit(f"recover: audio HTTP {status}")
    k = tts_key(voice, text, "history")
    (tdir / f"{scene_id}-{k}.mp3").write_bytes(audio)
    (tdir / f"{scene_id}-{k}.json").write_text(json.dumps({"scene": scene_id, "text": text, "endpoint": "history",
                                                           "historyItemId": history_id, "match": match,
                                                           "model": voice["model"], "voiceId": voice["voiceId"],
                                                           "settings": voice["settings"], "alignment": None},
                                                          ensure_ascii=False))
    led = load_ledger(work)
    led["requests"].append({"lang": lang, "scene": scene_id, "chars": len(text), "endpoint": "history-recover",
                            "status": 200, "historyItemId": history_id})
    led["sentChars"] += len(text)  # the lost response was charged; count it
    save_ledger(work, led)
    log(f"recover {lang}/{scene_id}: restored from history ({match})")


def command_template(voice, override):
    if override:
        return shlex.split(override)
    env = os.environ.get("SLP_TTS_CMD")
    if env:
        return shlex.split(env)
    if voice.get("command"):
        return list(voice["command"])
    sys.exit("tts command: set --tts-cmd or SLP_TTS_CMD (placeholders: {jobs} {lang})")


def step_tts_command(work: Path, lang: str, sc, voice, todo, template):
    """Local TTS: one sentence per job, joined per scene with a steady pause.

    Every uncached sentence goes into one JSONL file ({"text", "out", "language"}) and the
    command runs once, so a local model loads a single time. Sentence-level audio gives exact
    caption timing; reusing one voice prompt keeps the same speaker across scenes."""
    tdir = paths(work, lang)["tts"]
    cdir = tdir / "cues"
    cdir.mkdir(parents=True, exist_ok=True)
    gap = int(round(voice.get("cueGap", 0.38) * SAMPLE_RATE))
    plan, jobs = [], []
    for sid, text, _ in todo:
        scene = next(s for s in sc["scenes"] if s["id"] == sid)
        files = []
        for ci, cue in enumerate(scene["cues"]):
            line = spoken(cue, sc["pronunciation"])
            # A per-sentence seed override replaces a take that failed a check (e.g. dropped words).
            seed = voice.get("seedOverrides", {}).get(f"{sid}-{ci:02d}")
            tag = f"-s{seed}" if seed is not None else ""
            out = cdir / f"{sid}-{ci:02d}{tag}-{tts_key(voice, line, 'command')}.wav"
            files.append(out)
            if not out.exists():
                job = {"text": line, "out": str(out), "language": voice["languageCode"]}
                if seed is not None:
                    job["seed"] = seed
                jobs.append(job)
        plan.append((sid, text, files))
    if jobs:
        jf = cdir / "jobs.jsonl"
        jf.write_text("".join(json.dumps(j, ensure_ascii=False) + "\n" for j in jobs), encoding="utf-8")
        log(f"tts {lang}: {len(jobs)} sentences, {sum(len(j['text']) for j in jobs)} chars -> local command")
        run([arg.format(jobs=str(jf), lang=lang) for arg in template])
        missing = [j["out"] for j in jobs if not Path(j["out"]).exists()]
        if missing:
            sys.exit(f"tts command: {len(missing)} outputs missing, e.g. {missing[0]}")
    for sid, text, files in plan:
        pcm_all, cue_times, t = array("h"), [], 0
        for ci, out in enumerate(files):
            pcm = decode(out)
            s0, s1 = speech_bounds(pcm)
            pcm = pcm[int(s0 * SAMPLE_RATE):int(s1 * SAMPLE_RATE)]
            if ci:
                pcm_all.extend(array("h", bytes(gap * 2)))
                t += gap
            cue_times.append((t / SAMPLE_RATE, (t + len(pcm)) / SAMPLE_RATE))
            pcm_all.extend(pcm)
            t += len(pcm)
        k = tts_key(voice, text, "command")
        wav = tdir / f"{sid}-{k}.wav"
        with wave.open(str(wav), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(pcm_all.tobytes())
        (tdir / f"{sid}-{k}.json").write_text(json.dumps({"scene": sid, "text": text, "endpoint": "command",
                                                          "audio": wav.name, "model": voice["model"],
                                                          "instruct": voice.get("instruct"), "reference": voice.get("reference"),
                                                          "cues": [f.name for f in files], "cueTimes": cue_times},
                                                         ensure_ascii=False))
    log(f"tts {lang}: {len(plan)} scenes assembled from local sentence audio")


def step_tts(work: Path, lang: str, backend: str, audio_dir: Path | None, max_chars: int,
             allow_network: bool = False, tts_cmd: str | None = None):
    sc = load_script(lang)
    _, voice = voice_of(sc)
    if backend == "auto":
        backend = voice["backend"]
    tdir = paths(work, lang)["tts"]
    tdir.mkdir(parents=True, exist_ok=True)
    todo = []
    for scene in sc["scenes"]:
        text, spans = scene_passage(scene, sc["pronunciation"])
        if not find_cache(tdir, scene["id"], voice, text):
            todo.append((scene["id"], text, spans))
    if not todo:
        log(f"tts {lang}: all {len(sc['scenes'])} passages cached")
        return
    if backend == "import":
        for sid, text, spans in todo:
            src = next((p for p in (audio_dir / lang / f"{sid}.mp3", audio_dir / lang / f"{sid}.wav") if p.exists()), None)
            if not src:
                sys.exit(f"tts import: missing {audio_dir / lang / sid}.mp3|wav")
            k = tts_key(voice, text, "plain")
            run(["ffmpeg", "-v", "error", "-y", "-i", str(src), "-ac", "1", "-ar", str(SAMPLE_RATE),
                 "-c:a", "libmp3lame", "-b:a", "128k", str(tdir / f"{sid}-{k}.mp3")])
            (tdir / f"{sid}-{k}.json").write_text(json.dumps({"scene": sid, "text": text, "endpoint": "plain",
                                                              "source": str(src), "alignment": None}, ensure_ascii=False))
        return
    if backend == "command":
        step_tts_command(work, lang, sc, voice, todo, command_template(voice, tts_cmd))
        return
    if backend != "elevenlabs":
        sys.exit(f"tts: backend {backend} has nothing to synthesize")
    if not allow_network:
        sys.exit("tts: the ElevenLabs backend calls a remote API; pass --allow-network-tts to use it")
    led = load_ledger(work)
    need = sum(len(t) for _, t, _ in todo)
    if led["sentChars"] + need > max_chars:
        sys.exit(f"tts: budget guard — sent {led['sentChars']} + needed {need} > {max_chars}")
    key = read_key()
    caps_p = work / "tts" / "caps.json"
    caps = json.loads(caps_p.read_text()) if caps_p.exists() else {}
    for sid, text, spans in todo:
        body = {"text": text, "model_id": voice["model"], "language_code": voice["languageCode"],
                "voice_settings": voice["settings"]}
        use_ts = caps.get("withTimestamps", True)
        endpoint = "with-timestamps" if use_ts else "plain"
        url = f"{API}/text-to-speech/{voice['voiceId']}{'/with-timestamps' if use_ts else ''}?output_format={voice['outputFormat']}"
        log(f"tts {lang}/{sid}: {len(text)} chars via {endpoint}")
        status, payload = http("POST", url, key, body)
        led["requests"].append({"lang": lang, "scene": sid, "chars": len(text), "endpoint": endpoint, "status": status})
        if status != 200 and use_ts:
            caps["withTimestamps"] = False
            caps["withTimestampsError"] = {"status": status, "detail": payload.decode("utf-8", "replace")[:300]}
            caps_p.write_text(json.dumps(caps, indent=1))
            save_ledger(work, led)
            log(f"tts: with-timestamps unavailable (HTTP {status}); falling back to plain audio")
            endpoint, use_ts = "plain", False
            url = f"{API}/text-to-speech/{voice['voiceId']}?output_format={voice['outputFormat']}"
            status, payload = http("POST", url, key, body)
            led["requests"].append({"lang": lang, "scene": sid, "chars": len(text), "endpoint": endpoint, "status": status})
        if status != 200:
            save_ledger(work, led)
            sys.exit(f"tts {lang}/{sid}: HTTP {status}: {payload.decode('utf-8', 'replace')[:300]}")
        if use_ts:
            caps["withTimestamps"] = True
            caps_p.write_text(json.dumps(caps, indent=1))
            doc = json.loads(payload)
            audio = base64.b64decode(doc["audio_base64"])
            alignment = doc.get("alignment")
        else:
            audio, alignment = payload, None
        k = tts_key(voice, text, endpoint)
        (tdir / f"{sid}-{k}.mp3").write_bytes(audio)
        (tdir / f"{sid}-{k}.json").write_text(json.dumps({"scene": sid, "text": text, "endpoint": endpoint,
                                                          "model": voice["model"], "voiceId": voice["voiceId"],
                                                          "settings": voice["settings"], "alignment": alignment},
                                                         ensure_ascii=False))
        led["sentChars"] += len(text)
        save_ledger(work, led)
    log(f"tts {lang}: done; ledger sentChars={led['sentChars']}")


# ------------------------------------------------------------ timeline -----
def decode(mp3: Path):
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(mp3), "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "-"],
                         check=True, capture_output=True).stdout
    return array("h", raw)


def frames_rms(pcm, hop):
    out = []
    for i in range(0, len(pcm), hop):
        seg = pcm[i:i + hop]
        out.append(math.sqrt(sum(v * v for v in seg[::4]) / max(1, len(seg[::4]))))
    return out


def speech_bounds(pcm):
    hop = SAMPLE_RATE // 100
    rms = frames_rms(pcm, hop)
    thr = max(rms) * 0.02 if rms else 0
    idx = [i for i, v in enumerate(rms) if v > thr]
    return (idx[0] / 100, (idx[-1] + 1) / 100) if idx else (0.0, len(pcm) / SAMPLE_RATE)


def split_by_pauses(pcm, spans, text_len):
    """Fallback cue timing: choose the pauses closest to the text-proportional positions."""
    hop = SAMPLE_RATE // 100
    rms = frames_rms(pcm, hop)
    thr = max(rms) * 0.03
    pauses, run_start = [], None
    for i, v in enumerate(rms + [0]):
        if v <= thr and run_start is None:
            run_start = i
        elif v > thr and run_start is not None:
            if i - run_start >= 15:
                pauses.append((run_start / 100, i / 100))
            run_start = None
    s0, s1 = speech_bounds(pcm)
    n = len(spans)
    expected = [s0 + (s1 - s0) * spans[k][0] / text_len for k in range(1, n)]
    cands = [p for p in pauses if s0 < p[0] < s1]
    # DP: assign each boundary to a distinct pause, in order, minimising distance.
    INF = float("inf")
    m = len(cands)
    if m < n - 1:
        bounds = [(e, e) for e in expected]
    else:
        dp = [[INF] * (m + 1) for _ in range(n)]
        bk = [[0] * (m + 1) for _ in range(n)]
        for j in range(m + 1):
            dp[0][j] = 0
        for k in range(1, n):
            for j in range(k, m + 1):
                c = cands[j - 1]
                cost = abs((c[0] + c[1]) / 2 - expected[k - 1]) - 0.3 * min(1.0, c[1] - c[0])
                best = min(range(k - 1, j), key=lambda jj: dp[k - 1][jj])
                dp[k][j] = dp[k - 1][best] + cost
                bk[k][j] = best
        j = min(range(n - 1, m + 1), key=lambda jj: dp[n - 1][jj])
        chosen = []
        for k in range(n - 1, 0, -1):
            chosen.append(cands[j - 1])
            j = bk[k][j]
        bounds = list(reversed(chosen))
    starts = [s0] + [b[1] for b in bounds]
    ends = [b[0] for b in bounds] + [s1]
    return list(zip(starts, ends)), "pauses"


def cue_times(meta, pcm, spans, text):
    if meta.get("cueTimes"):
        return [tuple(x) for x in meta["cueTimes"]], "sentences"
    al = meta.get("alignment")
    if al and len(al.get("characters", [])) == len(text):
        st, en = al["character_start_times_seconds"], al["character_end_times_seconds"]
        out = []
        for a, b in spans:
            while a < b and text[a].isspace():
                a += 1
            out.append((st[a], en[b - 1]))
        return out, "alignment"
    return split_by_pauses(pcm, spans, len(text))


def step_timeline(work: Path, lang: str, silent: bool):
    sc = load_script(lang)
    vname, voice = voice_of(sc)
    P = paths(work, lang)
    t, scenes, placements = 0.0, [], []
    for si, scene in enumerate(sc["scenes"]):
        start = t
        t += TITLE_LEAD if si == 0 else LEAD
        text, spans = scene_passage(scene, sc["pronunciation"])
        if silent:
            dur = len(text) / SILENT_CPS
            times = [(dur * a / len(text), dur * b / len(text)) for a, b in spans]
            method, s0, s1, mp3 = "estimate", 0.0, dur, None
        else:
            meta_p = find_cache(P["tts"], scene["id"], voice, text)
            if not meta_p:
                sys.exit(f"timeline {lang}: no audio for scene {scene['id']} (run tts)")
            meta = json.loads(meta_p.read_text(encoding="utf-8"))
            mp3 = scene_audio(meta_p)
            pcm = decode(mp3)
            s0, s1 = speech_bounds(pcm)
            times, method = cue_times(meta, pcm, spans, text)
        offset = t - s0  # speech onset lands at the scene's lead
        cues = [{"text": c["text"], "start": round(offset + a, 3), "end": round(offset + b, 3)}
                for c, (a, b) in zip(scene["cues"], times)]
        placements.append({"mp3": str(mp3) if mp3 else None, "offset": offset})
        t = offset + s1
        last = si + 1 == len(sc["scenes"])
        t += LAST_TAIL if last else TAIL
        scenes.append({"id": scene["id"], "chapter": scene["chapter"], "title": scene["title"], "start": round(start, 3),
                       "end": round(t, 3), "last": last, "timing": method, "cues": cues})
    duration = round(math.ceil(t * FPS) / FPS, 3)
    v = voice
    timeline = {"lang": lang, "fps": FPS, "width": 1920, "height": 1080, "duration": duration,
                "narration": None if silent else {"profile": vname, "provider": v["provider"], "model": v["model"],
                                                   "voice": v["voiceName"], "voiceId": v.get("voiceId"),
                                                   "instruct": v.get("instruct"), "settings": v["settings"],
                                                   "license": v.get("license")},
                "labels": {**sc["labels"], **v["labels"]}, "scenes": scenes}
    P["timeline"].write_text(json.dumps(timeline, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    write_vtt(timeline, P["vtt"], sc)
    if not silent:
        build_audio(P["audio"], timeline, placements)
    log(f"timeline {lang}: {duration:.2f}s, {len(scenes)} scenes, {sum(len(s['cues']) for s in scenes)} cues, "
        f"timing={sorted({s['timing'] for s in scenes})}")


def vtt_ts(x):
    h, rem = divmod(x, 3600)
    m, s = divmod(rem, 60)
    return f"{int(h):02d}:{int(m):02d}:{s:06.3f}"


def write_vtt(tl, out: Path, sc):
    note = sc["basis"]["note"]
    credit = tl["labels"].get("credit", "") if tl["narration"] else ""
    lines = ["WEBVTT", "", f"NOTE {sc['title']}. {note} {credit}".strip(), ""]
    n = 1
    for s in tl["scenes"]:
        for c in s["cues"]:
            lines += [str(n), f"{vtt_ts(c['start'])} --> {vtt_ts(c['end'] + 0.25)}", c["text"], ""]
            n += 1
    out.write_text("\n".join(lines), encoding="utf-8")


def build_audio(out: Path, tl, placements):
    total = int(round(tl["duration"] * SAMPLE_RATE))
    buf = array("h", bytes(total * 2))
    for pl in placements:
        pcm = decode(Path(pl["mp3"]))
        off = int(round(pl["offset"] * SAMPLE_RATE))
        for i in range(len(pcm)):
            j = off + i
            if 0 <= j < total:
                buf[j] = pcm[i]
    out.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(out), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(buf.tobytes())
    log("audio:", out)


# -------------------------------------------------------------- render -----
def chrome_path():
    env = os.environ.get("SLP_VIDEO_CHROME")
    if env:
        return env
    return "/opt/google/chrome/chrome" if Path("/opt/google/chrome/chrome").exists() else None


def open_stage(p, timeline_path):
    exe = chrome_path()
    browser = p.chromium.launch(executable_path=exe) if exe else p.chromium.launch()
    page = browser.new_page(viewport={"width": 1920, "height": 1080}, device_scale_factor=1)
    page.goto(STAGE.as_uri())
    page.evaluate("document.fonts.ready.then(() => true)")
    info = page.evaluate("tl => init(tl)", json.loads(Path(timeline_path).read_text(encoding="utf-8")))
    return browser, page, info


def render_range(args):
    first, last, frames_dir, timeline_path = args
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser, page, _ = open_stage(p, timeline_path)
        for f in range(first, last):
            page.evaluate("t => renderAt(t)", f / FPS)
            page.screenshot(path=str(Path(frames_dir) / f"{f:06d}.jpg"), type="jpeg", quality=93)
        browser.close()
    return last - first


def step_render(work: Path, lang: str, jobs: int):
    P = paths(work, lang)
    tl = json.loads(P["timeline"].read_text(encoding="utf-8"))
    n = int(round(tl["duration"] * FPS))
    frames = P["frames"]
    if frames.exists():
        shutil.rmtree(frames)
    frames.mkdir(parents=True)
    chunk = math.ceil(n / jobs)
    ranges = [(i, min(n, i + chunk), str(frames), str(P["timeline"])) for i in range(0, n, chunk)]
    log(f"render {lang}: {n} frames with {len(ranges)} workers")
    with ProcessPoolExecutor(max_workers=jobs) as ex:
        done = sum(ex.map(render_range, ranges))
    log(f"render {lang}: {done} frames written to {frames}")


def step_lint(work: Path, lang: str):
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser, page, info = open_stage(p, paths(work, lang)["timeline"])
        browser.close()
    miss = info.get("untranslated", [])
    log(f"lint {lang}: {len(miss)} untranslated strings")
    for s in miss:
        print("  ", s)
    return miss


def step_stills(work: Path, lang: str, times):
    from playwright.sync_api import sync_playwright
    out = paths(work, lang)["stills"]
    out.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser, page, _ = open_stage(p, paths(work, lang)["timeline"])
        for t in times:
            page.evaluate("t => renderAt(t)", t)
            path = out / f"still-{t:07.2f}.png"
            page.screenshot(path=str(path))
            log("still:", path)
        browser.close()


def step_poster(work: Path, lang: str):
    from playwright.sync_api import sync_playwright
    from PIL import Image
    P = paths(work, lang)
    tl = json.loads(P["timeline"].read_text(encoding="utf-8"))
    mins, secs = divmod(int(round(tl["duration"])), 60)
    label = tl["labels"]["poster"].replace("{dur}", f"{mins}:{secs:02d}")
    png = P["stills"] / "poster.png"
    png.parent.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as p:
        browser, page, _ = open_stage(p, P["timeline"])
        page.evaluate("([t, l]) => renderAt(t, { poster: l })", [tl["scenes"][0]["end"] - 0.6, label])
        page.screenshot(path=str(png))
        browser.close()
    Image.open(png).convert("RGB").resize((1280, 720), Image.LANCZOS).save(P["poster"], "JPEG", quality=86,
                                                                          optimize=True, progressive=True)
    log("poster:", P["poster"])


def step_encode(work: Path, lang: str, silent: bool, crf: int, abr: str):
    P = paths(work, lang)
    tl = json.loads(P["timeline"].read_text(encoding="utf-8"))
    P["mp4"].parent.mkdir(parents=True, exist_ok=True)
    cmd = ["ffmpeg", "-hide_banner", "-y", "-framerate", str(FPS), "-i", str(P["frames"] / "%06d.jpg")]
    if not silent:
        cmd += ["-i", str(P["audio"])]
    cmd += ["-map", "0:v"] + ([] if silent else ["-map", "1:a"])
    cmd += ["-c:v", "libx264", "-preset", "veryslow", "-tune", "animation", "-crf", str(crf), "-pix_fmt", "yuv420p",
            "-profile:v", "high", "-g", str(FPS * 6), "-r", str(FPS)]
    if not silent:
        cmd += ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", str(SAMPLE_RATE), "-ac", "1", "-c:a", "aac", "-b:a", abr,
                "-metadata:s:a:0", f"language={'eng' if lang == 'en' else 'vie'}"]
    cmd += ["-t", f"{tl['duration']:.3f}", "-movflags", "+faststart",
            "-metadata", f"title={tl['labels']['mp4Title']}",
            "-metadata", f"comment={tl['labels']['credit']}. Explanatory animation of the working source, not live footage. "
                         f"Source: docs/media/paseo-slp-overview/source. {(tl.get('narration') or {}).get('license') or ''}".strip(),
            str(P["mp4"])]
    run(cmd)
    size = P["mp4"].stat().st_size
    log(f"mp4 {lang}: {P['mp4']} {size} bytes")
    if size > MAX_MP4_BYTES:
        log(f"WARNING: {size} bytes exceeds the {MAX_MP4_BYTES}-byte attachment budget; raise --crf or lower --abr")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("step", choices=["plan", "quota", "recover", "tts", "timeline", "lint", "stills", "render", "encode", "poster", "all"])
    ap.add_argument("--lang", choices=["en", "vi", "both"], default="both")
    ap.add_argument("--work", type=Path, default=REPO / ".local-checks" / "video-render-paseo-slp-overview")
    ap.add_argument("--voice", help="voice profile in the script's voices map (default: defaultVoice)")
    ap.add_argument("--tts", choices=["auto", "command", "elevenlabs", "import", "silent"], default="auto",
                    help="auto = the voice profile's backend")
    ap.add_argument("--tts-cmd", help="local TTS command template for the command backend")
    ap.add_argument("--allow-network-tts", action="store_true", help="required for the remote ElevenLabs backend")
    ap.add_argument("--audio-dir", type=Path)
    ap.add_argument("--max-chars", type=int, default=8700, help="cumulative characters this work dir may send")
    ap.add_argument("--jobs", type=int, default=max(1, min(6, (os.cpu_count() or 2) - 1)))
    ap.add_argument("--crf", type=int, default=28)
    ap.add_argument("--abr", default="72k")
    ap.add_argument("--at", type=float, nargs="*", default=[])
    ap.add_argument("--scene", help="scene id for the recover step")
    ap.add_argument("--history-id", help="ElevenLabs history item id for the recover step")
    a = ap.parse_args()
    global VOICE
    VOICE = a.voice
    a.work.mkdir(parents=True, exist_ok=True)
    langs = ["en", "vi"] if a.lang == "both" else [a.lang]
    silent = a.tts == "silent"
    if a.step == "plan":
        step_plan(langs)
        return
    if a.step == "quota":
        step_quota()
        return
    if a.step == "recover":
        step_recover(a.work, langs[0], a.scene, a.history_id)
        return
    for lang in langs:
        if a.step in ("tts", "all") and not silent:
            step_tts(a.work, lang, a.tts, a.audio_dir, a.max_chars, a.allow_network_tts, a.tts_cmd)
        if a.step in ("timeline", "all"):
            step_timeline(a.work, lang, silent)
        if a.step == "lint":
            step_lint(a.work, lang)
        if a.step == "stills":
            step_stills(a.work, lang, a.at)
        if a.step in ("render", "all"):
            step_render(a.work, lang, a.jobs)
        if a.step in ("encode", "all"):
            step_encode(a.work, lang, silent, a.crf, a.abr)
        if a.step in ("poster", "all"):
            step_poster(a.work, lang)


if __name__ == "__main__":
    main()

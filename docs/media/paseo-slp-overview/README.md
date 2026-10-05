# Paseo SLP video overview (Vietnamese and English)

Two explainers, one Vietnamese and one English, show how a brief becomes a controlled operation.
Both use the same 13 scenes. They are **explanatory animations of the working source** (`8365ce9`,
plugin 0.5.0, SDK 0.10.0), not footage of a live daemon and not E2E proof. For detail and SHA-256
source pins, read [docs/plugin-explained.html](../../plugin-explained.html). The video credits that guide
as it was when the videos were made.

The final guide card was updated to the current HTML (`dda36b07…`): 16 chapters and 57 source pins.
This changed only the closing scene's labels; both narration tracks and caption timings are unchanged.

The MP4 files are not stored in this repository. They are published as GitHub attachments, and this
folder holds what you need to rebuild them.

| File | Contents |
|---|---|
| `paseo-slp-overview.vi.vtt`, `paseo-slp-overview.en.vtt` | Captions, timed per narrated sentence (also burned into the video) |
| `poster.vi.jpg`, `poster.en.jpg` | 1280×720 poster frames |
| `source/script.vi.json`, `source/script.json` | Narration and on-screen titles per language, with voice profiles and labels |
| `source/stage.html` | Deterministic SVG/HTML animation with an EN→VI dictionary for on-screen text; `renderAt(t)` draws frame `t` |
| `source/timeline.vi.json`, `source/timeline.en.json` | Generated scene and caption timing, measured from the narration audio |
| `source/build.py` | TTS, timeline, translation lint, frame render, encode and poster pipeline |
| `source/omnivoice_tts.py` | Local OmniVoice driver: voice design, clone prompt, batch synthesis |
| `NOTICE` | Third-party notices for the narration model and audio tokenizer |

## Narration

The narrator is a synthetic male voice generated locally with [OmniVoice](https://github.com/k2-fsa/OmniVoice)
(k2-fsa, source pin `08be0b4`, model `k2-fsa/OmniVoice` pin `c5fdb5c`). Each language starts from one
voice-design sample (`male, middle-aged, very low pitch`, fixed seed). That sample becomes the clone prompt for
every sentence, so the speaker stays the same throughout. No real or third-party voice is cloned.
The narration plays at its natural pace; nothing is sped up to fit a target length.

Licences and attribution:

- OmniVoice code is Apache-2.0. The pre-trained OmniVoice model is licensed CC BY-NC (model card),
  so the narration is for non-commercial use with attribution.
- OmniVoice's audio tokenizer is Boson Higgs Audio 2. Built with Higgs Materials licensed from Boson AI USA,
  Inc., Copyright Boson AI USA, Inc., All Rights Reserved and Meta Llama 3 licensed under the Meta Llama 3
  Community License, Copyright Meta Platforms, Inc., All Rights Reserved. Boson Higgs Audio 2 is licensed
  under the Boson Community License, Copyright © Boson AI USA, Inc. All Rights Reserved.
- This attribution also appears in each MP4's metadata and as a short on-screen credit. See [NOTICE](NOTICE).

## Rebuild

You need Python 3.10+ with `playwright` and `Pillow`, a Chrome or Chromium binary (set `SLP_VIDEO_CHROME`
to choose one), and `ffmpeg`. Narration needs a separate OmniVoice environment and its local model
directory. CPU works; it is just slower. Intermediate files go to `--work`, which must be outside the
tracked tree, for example `.local-checks/…`.

```sh
PY=<omnivoice-venv>/bin/python; MODEL=<omnivoice-model-dir>; W=.local-checks/video-render
S=docs/media/paseo-slp-overview/source
$PY $S/omnivoice_tts.py design --model $MODEL --language vi --text "<reference sentence>" --out $W/vi-ref.wav
$PY $S/omnivoice_tts.py prompt --model $MODEL --ref $W/vi-ref.wav --text "<reference sentence>" --out $W/vi-voice.pt
python3 $S/build.py tts --lang vi --work $W \
  --tts-cmd "$PY $S/omnivoice_tts.py batch --model $MODEL --voice-prompt $W/vi-voice.pt --jobs {jobs} --language {lang}"
for step in timeline lint render encode poster; do python3 $S/build.py $step --lang vi --work $W; done
```

Repeat with `--lang en` and an English reference sentence. `build.py plan` prints the spoken text size.
`--tts silent` builds a captions-only layout preview. The `elevenlabs` profile in the scripts recorded an
earlier preview; it calls a remote API and refuses to run without `--allow-network-tts`.

## Limits

- The diagrams simplify the mechanisms. The guide and the cited source files are authoritative.
- The video shows no live host, ledger or SDK operation, and it does not demonstrate installation or
  acceptance.
- Synthetic speech can mispronounce English terms inside Vietnamese sentences. The captions show the exact
  wording.

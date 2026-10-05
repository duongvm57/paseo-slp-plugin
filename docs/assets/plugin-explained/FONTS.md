# Embedded fonts — plugin-explained.html

`docs/plugin-explained.html` is self-contained: it embeds these typefaces as
base64 WOFF2 inside a `@font-face` block so Vietnamese and Latin-Extended text
renders offline with no system-font fallback.

| Face | Weights embedded | Version | Source | License |
|---|---|---|---|---|
| Be Vietnam Pro | 400 / 500 / 600 / 700 | 1.002; ttfautohint (v1.8.3) | https://github.com/bettergui/BeVietnamPro (Google Fonts) | SIL OFL 1.1 — `OFL-BeVietnamPro.txt` |
| IBM Plex Mono | 400 / 600 | 2.3 | https://github.com/IBM/plex (Google Fonts) | SIL OFL 1.1 — `OFL-IBMPlexMono.txt` |

The WOFF2 payloads are the complete upstream fonts — no subsetting — so every
Vietnamese precomposed/combining diacritic and Latin-Extended glyph is present.
Conversion: `fontTools.ttLib` TTF→WOFF2 (brotli). Copyright notices are
preserved inside the embedded font binaries.

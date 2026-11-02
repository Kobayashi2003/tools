# Crawler ports

Range `18000–18999`, in slots of 10; the rules are in the root
[PORTS.md](../../PORTS.md). Projects not listed do not listen.

| Project | Slot | Ports |
|---|---|---|
| jable-downloader | 18000–18029 | Clash pool: instance *i* takes 18000+3*i* (HTTP), +1 (SOCKS), +2 (controller); at most 10 instances |
| novelia-downloader-v2 | 18030–18039 | 18030 serve · 18031 `tests/ui_preview.py` |
| tmw-downloader-v2 | 18040–18049 | 18040 http, stepping up to 18049 if taken |
| fc2-sukebei-browser | 18050–18059 | 18050 serve |
| pawchive-downloader-v2 | 18060–18069 | 18060 serve |

Lowest free slot: 18070.

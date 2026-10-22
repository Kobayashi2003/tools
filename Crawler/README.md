# Crawler

Downloaders and local library managers for specific sites, one folder each. Apps
that listen take a slot in `18000–18999` ([PORTS.md](../../PORTS.md)); the rest
have none.

| Folder | What it is | Ports |
|---|---|---|
| [annas-archive-downloader](annas-archive-downloader/) | Searches Anna's Archive and downloads the best file per volume | — |
| [fc2-sukebei-browser](fc2-sukebei-browser/) | Crawler and web UI for FC2 torrents on sukebei | 18050 serve |
| [google-play-comics-downloader](google-play-comics-downloader/) | Console script that saves pages from the Google Play Books reader | — |
| [jable-downloader](jable-downloader/) | HLS videos and covers from Jable.tv | 18000–18029 Clash pool: instance *i* takes 18000+3*i* (HTTP), +1 (SOCKS), +2 (controller); at most 10 instances |
| [khinsider-downloader](khinsider-downloader/) | Game soundtrack albums from KHInsider | — |
| [nhentai-downloader](nhentai-downloader/) | Gallery images from nhentai and imhentai | — |
| [novelia-downloader-v2](novelia-downloader-v2/) | Crawler and library manager for Novelia's light novels | 18030 serve · 18031 `tests/ui_preview.py` |
| [pawchive-downloader-v2](pawchive-downloader-v2/) | Archives Pawchive and Fanbox creators | 18060 serve |
| [tmw-downloader-v2](tmw-downloader-v2/) | Searchable page over TMW Reading Club's Discord channels | 18040 http, stepping up to 18049 if taken |
| [vgmdb-downloader](vgmdb-downloader/) | Userscript that downloads every image on a VGMdb album page | — |
| [x-image-downloader](x-image-downloader/) | Full-resolution images from X timelines | — |

Free slots: 18070 and up.

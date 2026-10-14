# google-play-comics-downloader

Browser console script that saves comic page images from the
[Google Play Books](https://play.google.com/books) web reader as you read.

## Use

Open a book in the web reader, paste `main.js` into the DevTools console, then call:

| Command | Effect |
|---|---|
| `startDownload()` / `stopDownload()` | Start / stop collecting and downloading pages |
| `pauseDownload()` / `resumeDownload()` | Pause / resume downloading (collecting continues) |
| `setDelay(ms)` | Interval between downloads (default 3000) |
| `startAutoScroll()` / `stopAutoScroll()` | Scroll through the book automatically |
| `getStatus()` | Print the current state |

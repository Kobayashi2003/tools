# google-play-comics-downloader

A downloader for [Google Play Books](https://play.google.com/books). Browser console script that captures and downloads comic/manga page images in real-time as you read.

## Usage

1. Open a book in [Google Play Books](https://play.google.com/books) web reader
2. Open browser Developer Tools (F12) → Console
3. Paste the contents of `main.js` and press Enter
4. Run the following commands in the console:

```javascript
startDownload()    // Start collecting and downloading images
startAutoScroll()  // Auto-scroll to load more pages
```

### Console Commands

| Command | Description |
|---|---|
| `startDownload()` | Start real-time image collecting and downloading |
| `stopDownload()` | Stop collecting |
| `pauseDownload()` | Pause downloading (keep collecting) |
| `resumeDownload()` | Resume downloading |
| `setDelay(ms)` | Set download interval (default: 3000ms) |
| `startAutoScroll()` | Start auto-scrolling |
| `stopAutoScroll()` | Stop auto-scrolling |
| `getStatus()` | Show current status |

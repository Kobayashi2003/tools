# Click Image Downloader

A Chrome (Manifest V3) extension: hold a modifier key and left-click any image
to download it. Handles overlapping images by letting you scroll to switch
between them before downloading.

## Usage

1. Hold the trigger key (**Alt** by default) and move the mouse over an image —
   it gets outlined and a badge shows its dimensions and file name.
2. When images overlap under the cursor, **scroll the mouse wheel** (while still
   holding the key) to cycle the highlight through them — the badge shows `1/N`.
3. **Left-click** while holding the key to download the highlighted image.

Open the toolbar popup to enable/disable the extension and change the trigger
key (Alt / Ctrl / Shift / ⌘·Win).

## What it can grab

- `<img>` elements (uses `currentSrc`, so it respects `srcset`/responsive images)
- CSS `background-image` on any element
- `<canvas>` (exported as PNG; tainted canvases are skipped)
- inline `<svg>` (serialized to an SVG file)
- `<video>` poster frames
- `blob:` images (inlined to a data URL before downloading)

## Install (unpacked)

1. Go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `click-image-downloader` folder.

## Files

| File           | Role                                                              |
| -------------- | ----------------------------------------------------------------- |
| `manifest.json`| MV3 manifest (downloads + storage permissions, all-frames script) |
| `content.js`   | Detects images under the cursor, highlight + scroll-cycle + click |
| `content.css`  | Styles for the highlight box and info badge                       |
| `background.js`| Service worker that runs `chrome.downloads.download`              |
| `popup/`       | Toolbar UI: enable toggle + trigger-key selector                  |

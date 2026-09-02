# Page Screenshot

A Chrome (Manifest V3) extension with two capture modes: a plain **visible-area**
screenshot, and a **full-page (long) screenshot** that auto-scrolls the page in
viewport-sized steps, stitches every frame into one image, and downloads it as PNG.

## Usage

1. Open the toolbar popup on the page you want to capture.
2. Click **Capture visible area** for an instant screenshot of just what's on
   screen, or **Capture full page** to auto-scroll and stitch the whole page.
3. For a full-page capture, progress is shown in the popup and as a badge on
   the toolbar icon — safe to close the popup, the capture keeps running in
   the background. Either mode downloads its PNG automatically and confirms
   with a notification.

## How it works

- `background.js` (service worker) drives both modes:
  - **Visible area**: a single `chrome.tabs.captureVisibleTab` call, downloaded as-is.
  - **Full page**: it injects small functions into the page via
    `chrome.scripting.executeScript` to find what actually scrolls (the
    document, or — for app-shell layouts like Element UI's `<el-main>` where
    `<html>`/`<body>` don't scroll — the largest inner scrollable container),
    hides fixed/sticky elements that would otherwise duplicate, then scrolls
    and calls `chrome.tabs.captureVisibleTab` for each step.
- Frames are stitched with an `OffscreenCanvas` inside the service worker —
  no content script or extra page needed for the image compositing. Anything
  outside the scrolling region (e.g. a fixed header above an inner scroll
  container) is drawn once; the scrolling region itself is cropped and
  stacked across frames.
- Results are downloaded as a base64 `data:` URL built by hand (not
  `URL.createObjectURL`, which extension service workers don't reliably expose).

## Limitations

- Only vertical scrolling is captured (no horizontal long-screenshots).
- Fixed/sticky elements inside the scrolling region are hidden during a
  full-page capture to avoid duplication, so they won't appear in the final image.
- Extremely tall pages can exceed the browser's canvas size limit; capture
  fails with a clear error in that case instead of producing a corrupt image.

## Install (unpacked)

1. Go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select this `full-page-screenshot` folder.

## Files

| File            | Role                                                          |
| --------------- | -------------------------------------------------------------- |
| `manifest.json` | MV3 manifest (downloads/scripting/tabs/notifications perms)   |
| `background.js` | Visible-area capture + scroll → capture → stitch → download orchestration |
| `popup/`        | Toolbar UI: two capture buttons + live progress                |

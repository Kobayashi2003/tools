# Page Screenshot

Chrome extension that captures the visible area, or the full page by scrolling and stitching
frames, and downloads it as PNG.

## Use

Open the popup and choose **Capture visible area** or **Capture full page**. A full-page capture
keeps running if the popup closes; progress shows on the toolbar badge.

Limitations: vertical scrolling only; fixed and sticky elements inside the scrolling region are
hidden during the capture; pages taller than the browser's canvas limit fail with an error.

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → select this folder.

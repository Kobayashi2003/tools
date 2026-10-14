# Resource Grabber

Chrome extension that collects resource URLs from every frame of the current page and downloads
or copies them.

## Use

Open the popup, choose a mode, enter a pattern and press **Grab resources**:

- **Regex mode**: a regular expression matched against the full URL, e.g. `\.(png|jpg|mp4)$`.
- **Suffix mode**: comma-separated file extensions, e.g. `mp4, webm, jpg`.

URLs come from `src`, `href`, `data-src`, `action` and `srcset` attributes and from CSS `url(...)`
in inline styles and `<style>` elements; only `http(s)` URLs are kept. Results can be downloaded
or copied one by one or all at once.

Resources loaded only by scripts or external stylesheets are not found.

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → select this folder.

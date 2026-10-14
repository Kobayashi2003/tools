# x-image-downloader

Downloads full-resolution images from users' [X](https://x.com) timelines into
`<output>/<author>/`, skipping reposts and ads and anything already in the log.

## Run

Requires Python 3.14; dependencies are in `pyproject.toml`. Install Playwright's Chromium once
(`playwright install chromium`) and export your X cookies to `cookies.json`.

```bash
python main.py <url> [<url> ...] [options]
```

| Option | Description | Default |
|---|---|---|
| `urls` | Timeline URLs, e.g. `https://x.com/<user>` | — |
| `-c, --cookies` | Cookie file | `cookies.json` |
| `-o, --output` | Output directory | `images` |
| `-l, --log` | Dedup log file | `log.json` |
| `--headless` | Run the browser headless | off |

# x-image-downloader

Scrapes a user's [X (Twitter)](https://x.com) timeline with Playwright and downloads full-resolution images, skipping reposts/ads and de-duplicating via a JSON log. Images are saved under `output/<author>/`.

## Install

```bash
pip install -r requirements.txt
playwright install chromium
```

Export your X cookies to `cookies.json` (browser-export format).

## Usage

```bash
python main.py <url> [<url> ...] [options]
```

| Option | Description | Default |
|---|---|---|
| `urls` | One or more user timeline URLs, e.g. `https://x.com/<user>` | — |
| `-c, --cookies` | Path to `cookies.json` | `cookies.json` |
| `-o, --output` | Output directory | `images` |
| `-l, --log` | Dedup log file | `log.json` |
| `--headless` | Run the browser headless | off |

### Example

```bash
python main.py https://x.com/KuroTuki_nn -o images
```

Importable: `from main import run`.

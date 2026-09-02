# nhentai-downloader

Downloads sequentially numbered gallery images from [nhentai](https://nhentai.net) / [imhentai](https://imhentai.xxx) with async concurrency, batching and rate limiting.

## Install

```bash
pip install -r requirements.txt
```

## Usage

```bash
python main.py <base_url> --end <last_page> [options]
```

| Option | Description | Default |
|---|---|---|
| `base_url` | Gallery image base URL, e.g. `https://host/path/` | — |
| `-n, --end` | Last page number (required) | — |
| `-s, --start` | First page number | `1` |
| `-o, --output` | Output directory | `downloads` |
| `-e, --ext` | Image extension (`jpg`, `webp`, `png`, …) | `jpg` |
| `--cookies` | Path to a `cookies.json` file (browser-export list or simple dict) | — |
| `--concurrency` | Max concurrent downloads | `5` |
| `--delay` | Delay between downloads in a batch (s) | `1` |
| `--batch-size` | Images per batch | `5` |
| `--batch-delay` | Delay between batches (s) | `1` |

### Example

```bash
python main.py "https://m2.imhentai.xxx/008/yak45fbtvn/" -e jpg -n 403 -o "COMIC BAVEL 2017-01"
```

Importable: `from main import download_range`.

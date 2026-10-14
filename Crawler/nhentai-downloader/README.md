# nhentai-downloader

Downloads sequentially numbered gallery images from [nhentai](https://nhentai.net) and
[imhentai](https://imhentai.xxx), in rate-limited batches.

## Run

Requires Python 3.14; dependencies are in `pyproject.toml`.

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
| `--cookies` | `cookies.json` (browser export list or plain map) | — |
| `--concurrency` | Max concurrent downloads | `5` |
| `--delay` | Delay between downloads in a batch (s) | `1` |
| `--batch-size` | Images per batch | `5` |
| `--batch-delay` | Delay between batches (s) | `1` |

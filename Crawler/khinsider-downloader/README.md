# khinsider-downloader

Downloads video game music albums from [KHInsider](https://downloads.khinsider.com) — MP3/FLAC formats, booklet images and multi-CD layouts. Scraping uses Selenium; file downloads run concurrently.

## Install

```bash
pip install -r requirements.txt
```

A supported browser (Chrome, Edge, or Firefox) is required; WebDrivers are managed automatically by Selenium.

## Usage

```bash
python main.py <album_url> [<album_url> ...] [options]
```

| Option | Description | Default |
|---|---|---|
| `url` | One or more album URLs | — |
| `-o, --output` | Output directory | `downloads` |
| `-f, --format` | Audio format: `mp3`, `flac`, `both` | `both` |
| `-b, --browser` | Browser: `chrome`, `edge`, `firefox`, `auto` | `auto` |
| `--headless` | Run browser headless | off |
| `--no-booklet` | Skip booklet images | off |
| `--retry` | Retry each resource until it succeeds | off |
| `-w, --workers` | Max concurrent download threads | `4` |

### Example

```bash
python main.py "https://downloads.khinsider.com/game-soundtracks/album/album-name" -f flac
```

Importable: `from main import download_album, Config`.

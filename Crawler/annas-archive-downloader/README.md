# annas-archive-downloader

A downloader for [Anna's Archive](https://annas-archive.gl). Searches a keyword, works out which
volume each hit belongs to, keeps the best file per volume, and downloads the ones you tick.

"Best" is, in order: `epub` before every other format, then the larger file, then the newer date.
Both the order and the format list are configurable.

## Installation

```bash
pip install -r requirements.txt
```

`requests` and `beautifulsoup4` are required; `prompt_toolkit` adds the checkbox list and degrades
to a numbered prompt if absent; `selenium` is only needed for the `browser` backend.

## Usage

```bash
python main.py "Sword Art Online"
```

Ticked volumes land in `downloads/<keyword>/<volume> <title>.<ext>`. Existing files are skipped,
so re-running after an interruption resumes the set.

```
↑/↓ move · space toggle · a all · n none · i invert · enter download · q cancel

❯ [x] Vol.1   Sword Art Online Alternative Clover's Regret   EPUB · 23.5MB · 2024
  [x] Vol.3   Sword Art Online Progressive 3 [TNC]           EPUB · 15.1MB · 2017
```

Without a tty the same list is printed numbered and you type a selection: `1,3,5-8`, `all`,
`none`, `-4` to drop one, blank to accept.

| Option | Description | Default |
|---|---|---|
| `-o, --output_dir` | Output directory | `downloads` |
| `-p, --pages` | Search pages to read, 50 hits each | `1` |
| `-l, --language` | Language filter, e.g. `en`, `ja` | all |
| `-e, --extension` | Restrict the search to one format | all |
| `--mirror` | Anna's Archive mirror | `annas-archive.gl` |
| `--sort` | Server-side ordering (`newest`, `largest`, …) | relevance |
| `--rank` | Ranking keys: `format`, `size`, `date`, `fast` | `format,size,date` |
| `--format_priority` | Format preference order | `epub,azw3,mobi,fb2,djvu,cbz,cbr,pdf` |
| `--volume_from` | Read the volume from `auto`/`title`/`publisher`/`filename` | `auto` |
| `--volume_regex` | Custom volume pattern, one capturing group | — |
| `--loose` | Keep hits that miss a query word | off |
| `--partial` | Also take the site's "partial matches" | off |
| `--precise_date` | Rank on the real "date open sourced" | off |
| `--backend` | `auto`, `member`, `libgen`, `browser` | `auto` |
| `-k, --secret_key` | Membership key (also `ANNAS_SECRET_KEY`) | — |
| `-b, --browser` | `chrome`, `edge`, `firefox`, `auto` | `auto` |
| `-w, --workers` | Concurrent downloads | `3` |
| `-y, --yes` / `--dry-run` | Take everything / list and stop | off |

## Configuration

Anything above can live in `config.json` (copy `config.example.json`) or come from the
environment as `ANNAS_<OPTION>`.

```
precedence:  command line  >  environment  >  config.json  >  built-in defaults
```

`/search` and `/md5/` answer a plain client, but `/dyn/…` and `/slow_download/…` sit behind
DDoS-Guard. Exporting those cookies from a browser into `cookies.json` lets the plain client
through; a flat `{"name": "value"}` map or a browser extension's list export both work.

## Notes

Downloads are tried `member` → `libgen` → `browser` and stop at the first that yields a link.
`member` needs a key but is one request; `libgen` is free but only covers what Libgen holds —
Japanese light novels are largely absent, so those fall through to the browser, which is slow and
bounded by a per-record timeout.

Every file is checked against the md5 the archive keys it by, so a mirror answering with the
wrong book is caught rather than saved. Two picks that would build the same filename are given
distinct ones; a batch that cannot do so is refused rather than silently losing a file.

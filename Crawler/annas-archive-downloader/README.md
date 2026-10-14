# annas-archive-downloader

Searches [Anna's Archive](https://annas-archive.gl) for a keyword, keeps the best file per volume
(epub first, then larger, then newer) and downloads the volumes you tick.

## Run

Requires Python 3.14; dependencies are in `pyproject.toml`.

```bash
python main.py "Sword Art Online"
```

Files land in `downloads/<keyword>/<volume> <title>.<ext>`; existing files are skipped, so a
rerun resumes. Without a tty the list is numbered and takes a selection such as `1,3,5-8`, `all`
or `-4`.

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

Every option can also be set in `config.json` (see `config.example.json`) or as `ANNAS_<OPTION>`;
the command line wins, then the environment, then the file.

Download pages sit behind DDoS-Guard: export the browser's cookies to `cookies.json` to get
through. `auto` tries `member` (needs a key), then `libgen`, then a real browser (slow; needed
for titles Libgen lacks, such as most Japanese light novels).

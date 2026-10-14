# Novelia Downloader v2

A local crawler and library manager for [Novelia](https://n.novelia.cc/wenku): collects library
novels (light novels by default), tracks upstream changes, and builds verified Japanese-only
EPUBs from the bilingual downloads.

## Run

Requires Python 3.14; dependencies are in `pyproject.toml`.

```bash
python main.py serve --port 18030      # web UI on http://127.0.0.1:18030
python main.py doctor                  # check access to the live catalog
python main.py convert-local <bilingual-dir> --output <dir> --reference-dir <originals-dir>
```

On Windows, `start.ps1` / `stop.ps1` start and stop the server. One instance may use a data
directory at a time.

## Behaviour worth knowing

- **Work references** are catalog IDs or URLs: `wenku/<id>`, `alphapolis/<id>`, or the full
  `https://n.novelia.cc/...` link. Page and volume ranges are one-based and inclusive (`1,3,5-8`).
- **Update sweeps** download a volume only when its ID, translation counters or download
  settings changed, or the local file is missing or a different size. An upload replaced without
  those changing can't be detected; use **Download again even if unchanged**.
- **Failures**: 429/503 cool every request down together and pause the task, which resumes by
  itself. So do a run of network failures and a missing download drive; the affected items go
  back in the queue instead of failing. 404, damaged uploads and verification mismatches are
  permanent; 401/403 stop the task. Failed items can be retried at any time, including while
  the task runs, and a retry skips volumes already saved. Pacing, retries and active hours are
  in Settings.
- **Uploads Novelia can't convert**: when the bilingual file can't be built (some uploads make
  it fail every time), the Japanese original is saved as that volume's Japanese edition. Text
  (`.txt`) volumes are saved as text; their Japanese edition is the original upload.
- **Japanese conversion** keeps the Japanese paragraphs and the original's layout, then compares
  the result paragraph by paragraph with the original upload. Mismatches are saved with an
  `[UNVERIFIED]` filename; bilingual sources are always kept. `convert-local` writes a
  `conversion-report.json` and exits 1 if anything is unverified.
- **Removing works** keeps their files unless you tick the deletion option.

## Configuration

| Path / variable | Purpose |
| --- | --- |
| `data/library.sqlite3` | Works, files, tasks, logs, settings |
| `downloads/<kind_ID>/` | Bilingual sources, Japanese editions, references |
| `NOVELIA_DATA_DIR`, `NOVELIA_DOWNLOAD_DIR` | Override the two directories above (Settings → Download directory takes precedence) |
| `NOVELIA_TOKEN` / `NOVELIA_TOKEN_FILE` | Optional bearer token (default file: `token.txt`) |
| `NOVELIA_PROXY` | Optional HTTP(S) proxy |

Back up the database and the download directories together.

## Tests

```bash
pytest
```

API docs are served at `/docs`.

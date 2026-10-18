# Novelia Downloader v2

A local crawler and library manager for [Novelia](https://n.novelia.cc/wenku): collects library
novels (light novels by default), tracks upstream changes, and saves the Japanese originals,
the bilingual builds or the Chinese builds, converting bilingual files to Japanese or Chinese
editions where no original exists.

## Run

Requires Python 3.14.

```bash
python -m pip install fastapi requests uvicorn
python main.py serve --port 18030      # web UI on http://127.0.0.1:18030
python main.py doctor                  # check access to the live catalog
python main.py convert-local <bilingual-dir> --output <dir> --reference-dir <originals-dir>
```

One instance may use a data directory at a time. API docs are served at `/docs`.

## Behaviour worth knowing

- **Work references** are catalog IDs or URLs: `wenku/<id>`, `alphapolis/<id>`, or the full
  `https://n.novelia.cc/...` link. Page and volume ranges are one-based and inclusive (`1,3,5-8`).
- **Update sweeps** read the catalog (sorted by latest upload) only until it matches the order
  recorded by the last finished sweep, and check just the works before that point. Translation
  progress does not move a work, so **Everything** checks every work. A volume is downloaded
  only when its ID, translation counters or download settings changed, or the local file is
  missing or a different size; for an upload replaced without any of those changing, use
  **Download again even if unchanged**.
- **Failures**: 429/503, a run of network failures, a missing download drive or less than 2 GB
  free pause the task, which resumes by itself. 404 and damaged uploads fail the item; 401/403
  stop the task. Failed items can be retried at any time, and a retry skips volumes already
  saved.
- **Damaged uploads**: a broken picture or font, or a junk `mimetype` entry, is repaired on
  save. An upload that is empty or cut off on Novelia is skipped by later tasks until its
  metadata changes, or for 30 days.
- **Formats** (Settings → Download source): the bilingual build, the uploaded Japanese
  original (`[jp-original]`) and Novelia's Chinese-only build (`[zh]`), in any combination.
  When the bilingual file can't be built, the original can be kept instead. Text (`.txt`)
  volumes are saved as text.
- **Conversion** is for volumes Novelia has only as bilingual files. The Japanese edition
  (`[ja]`) keeps the Japanese paragraphs, optionally laid out vertically; the Chinese edition
  (`[zh]`) puts each translation in place of its Japanese line. Sources are kept.
  `convert-local` also checks its output against the originals in `--reference-dir`, writes
  `conversion-report.json` and exits 1 if anything is unverified.
- **Chinese-only uploads** are no longer on Novelia's pages and many are broken; they are
  skipped and hidden unless a setting brings them back.

## Configuration

| Path / variable | Purpose |
| --- | --- |
| `data/library.sqlite3` | Works, files, tasks, logs, settings |
| `downloads/<edition>/<kind_ID>/` | `Japanese/`, `Bilingual/`, `Chinese/` |
| `NOVELIA_DATA_DIR`, `NOVELIA_DOWNLOAD_DIR` | Override the two directories above (Settings → Download directory takes precedence) |
| `NOVELIA_TOKEN` / `NOVELIA_TOKEN_FILE` | Optional bearer token (default file: `token.txt`) |
| `NOVELIA_PROXY` | Optional HTTP(S) proxy |

Back up the database and the download directories together.

## Tests

```bash
python -m pip install pytest httpx
python -m pytest
```

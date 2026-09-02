# novelia-downloader

A downloader for [novelia](https://n.novelia.cc) (轻小说机翻机器人). Searches a keyword, shows the
matching works as a checkbox list, and downloads the ones you tick as **Japanese-only EPUBs laid
out for vertical reading**.

The site keeps two catalogues and one search covers both: 文库 (published volumes, one work is a
set of books) and 网络 (web novels, one work is a stream of chapters).

## Installation

```bash
pip install -r requirements.txt
```

## Usage

```bash
python main.py "強くてニューサーガ"          # search both catalogues
python main.py --id wenku/688da4c4c923db0b7aa9943e      # a library work, no token
python main.py --id alphapolis/159124863-713069479      # a web novel, no token
```

```
  強くてニューサーガ: 11 volume(s)
  got     [阿部正行]強くてニューサーガ1 [jp-zh].epub (5462 KB)
  convert [阿部正行]強くてニューサーガ1 [ja].epub
          22 chapter(s): kept 3598 Japanese paragraph(s), dropped 3598 Chinese;
          vertical-rl restored from the publisher's own stylesheet
          verify: OK — identical to the publisher's uploaded original
```

Library volumes land in `downloads/<query>/<work>/`, one file per volume.

| Option | Description | Default |
|---|---|---|
| `--id ID` | Take a work directly: `wenku/<id>` or `<provider>/<novelId>` | — |
| `-k, --kind` | Catalogue to search: `both`, `wenku`, `web` | `both` |
| `--volumes` | For library works: `1,3,5-8` | all |
| `-o, --output_dir` | Output directory | `downloads` |
| `-m, --mode` | Source build: `jp`, `zh`, `zh-jp`, `jp-zh` | `jp-zh` |
| `-p, --pages` | Search pages to read, 20 works each | `1` |
| `--translations` | Translation engines, best first | `sakura,gpt,youdao` |
| `--file_type` | `epub` or `txt` — web novels only | `epub` |
| `--no-convert` | Keep the bilingual file as downloaded | off |
| `--no-vertical` | Japanese-only but horizontal | off |
| `--keep_original` | Also keep the bilingual download | off |
| `--no-verify` | Skip the check against a Japanese reference | off |
| `-t, --token` | Login token (also `token.txt` / `NOVELIA_TOKEN`) | — |
| `-w, --workers` | Concurrent downloads | `3` |
| `-y, --yes` / `--dry-run` | Take everything / list and stop | off |

Anything above can live in `config.json` (copy `config.example.json`) or come from the
environment as `NOVELIA_<OPTION>`; the command line wins over both.

## The token

Only the **web-novel search** is authenticated. Library search, metadata and every file download
are open, so `--id` and `-k wenku` need no token. Without one you still get library results, with
a note saying what was skipped.

To enable web search, log in on the site and run this in the browser console:

```js
JSON.parse(localStorage.auth).profile.token
```

Save it to `token.txt` next to `main.py`, or set `NOVELIA_TOKEN`. Tokens expire.

## Notes

A library volume has **no Japanese-only build** — the site answers 400 — so the bilingual file is
the only route to the Japanese text of a published volume. That is what the converter is for.

The two catalogues mark up their bilingual files differently: web novels tag Japanese paragraphs
`lang="ja"`, library volumes reuse the publisher's EPUB and carry no `lang` at all. The one marker
present in both is the dimming style the site adds to the Japanese side, so that is what
identifies Japanese; a bare `<p>` holding text is the inserted translation and is dropped.
Headings carry no marker and are matched by kana instead.

The site's bilingual builds also break vertical reading — they strip `page-progression-direction`,
set `primary-writing-mode` to horizontal, and empty every stylesheet. For library volumes the
publisher's stylesheets are copied back from the uploaded original; web novels get a generated one.

Every conversion is checked paragraph by paragraph against a Japanese reference: the publisher's
original for a library volume, the site's own `mode=jp` build for a web novel. On a mismatch the
source is kept and the output is renamed `… [UNVERIFIED].epub` rather than passed off as finished.

# ranobe-hub

One console over [annas-archive-downloader](../annas-archive-downloader) and
[novelia-downloader](../novelia-downloader). Neither can answer the question you actually have —
*for this series, who has volume 7, and in what shape?* — because that only appears once both
catalogues are lined up against the same volume numbers.

It scrapes and converts nothing of its own: both siblings are imported as libraries and each
planned file is handed back to the project that owns it, so their fixes are inherited.

## Installation

Both projects must sit next to this one. `status` shows what got wired up.

```bash
pip install -r ../annas-archive-downloader/requirements.txt
pip install -r ../novelia-downloader/requirements.txt
pip install -r requirements.txt
```

## Usage

```bash
python main.py                       # console
python main.py "強くてニューサーガ"    # search on start-up, then console
python main.py "..." --once          # search, print, exit
```

`find` puts you in the arrow-key screens and `get` downloads what you planned there. Everything
in between is keys, not typing:

```
  in the result list          in the plan grid
    ↑/↓  move                   ↑/↓          volume
    enter open                  ←/→          source for that volume
    q    back to prompt         space        include / exclude
                                a / n        include all / none
                                p            cycle the policy and re-plan
                                r            drop hand-made choices
                                b            back to the result list
                                enter accept          q cancel
```

`←`/`→` *sets* the source rather than highlighting it, so a change is one keystroke and the plan
column updates as you go. Anything set by hand is marked `*` and the policy will not overrule it.

```
  vol   novelia/library    annas              plan
  [x]  1  ● epub 24ch       ● epub 2.3M ja     annas
  [x]  3  ● epub 25ch         ·                novelia/library
  plan: 14 volume(s) · annas 3 · novelia/library 11 · gaps: none · ≥17 MB (+11 unknown)
```

The plan mixes sources by itself — the archive wins the volumes whose copy is Japanese and loses
the ones whose copy is Chinese. `why <vol>` explains any single decision.

| Policy | Rule |
|---|---|
| `japanese` (default) | Japanese first, then the least-handled copy: `annas` > `novelia/library` > `novelia/web` |
| `archive` | prefer `annas`'s own file even when it is not Japanese |
| `smallest` / `largest` | by filesize |

Settings: `policy [name]`, `sources [both|annas|novelia]`, `out [dir]`, `status`. When the
terminal cannot host a full-screen screen (piped input, an odd `TERM`) the same edits are
available by typing — `list`, `open <n>`, `take`/`drop <spec>`, `use <vol> <source>`,
`unpin <vol>`, `why <vol>`. `help` lists everything.

## Notes

The catalogues disagree about granularity, which is the whole difficulty: `annas` is one file per
volume in mixed languages, `novelia/library` one file per published volume, and `novelia/web` a
single file for an entire serialisation. A web serialisation has no volumes, so it is listed
under the table as `whole series` rather than faked into rows.

Two judgements can go wrong and are deliberately visible rather than hidden. **Which results are
the same work** is decided by title after normalisation, with the volume number and everything
after it removed, and bracketed parts treated as decoration — so `落第騎士の英雄譚<キャバルリィ>`
folds into `落第騎士の英雄譚` while `Sword Art Online Progressive` stays separate from
`Sword Art Online`. Merging also requires the authors to agree, which keeps a manga adaptation out
of the novel it is based on. The result list shows the contributing sources per row so an
over-eager merge is something you can see. **Which volume a file is** comes from the annas volume
detector rather than a second implementation, so all three projects agree by construction.

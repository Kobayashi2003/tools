# NNN Voice Continue

Generate a dialogue voice patch for supported NNN engine builds used by Cyc and Black Cyc. A voiced line keeps playing across unvoiced text, including pages with voice sound effects, until it finishes or a new line replaces it on the same voice channel.

## Games processed

The following ten installations produced patches and serve as compatibility samples. The generator checks for supported engine code and script structures. It can accept another release or title if it matches those checks.

| Game                                                    | Executable       | Patched scripts | Skipped stop commands |
| ------------------------------------------------------- | ---------------- | --------------: | --------------------: |
| AGEHA-EXTRAVAGANZA-                                     | `ageha.exe`      |               1 |                 1,115 |
| EXTRAVAGANZA ～蟲愛でる少女～                           | `mushiai.exe`    |               9 |                 6,935 |
| EXTRAVAGANZA～末路の果てに～                            | `matsuro.exe`    |               1 |                   399 |
| EXTRAVAGANZA～蟲狂編～                                  | `mushigurui.exe` |               5 |                 2,233 |
| MinDeaD BlooD -Complete Edition- ～支配者の為の狂死曲～ | `bloodv7.exe`    |              28 |                 6,586 |
| MinDeaD BlooD -Complete Edition- ～麻由と麻奈の輸血箱～ | `yuketsuv7.exe`  |              15 |                 3,482 |
| ク・リトル・リトル ～魔女の使役る、蟲神の触手～         | `cll.exe`        |               9 |                 3,475 |
| ゴア・スクリーミング・ショウ Version 2.02               | `gss.exe`        |              15 |                 7,646 |
| 小夜子                                                  | `sayoko.exe`     |               4 |                 2,067 |
| 狗哭                                                    | `inunaki.exe`    |              13 |                 4,006 |

**Examined and skipped.** 蟲使い (`mushi.exe`) stops voices in its message handling code and shares a player between voices and sound effects. It requires a separate engine patch.

## Generate patches

Use Node.js 24. Run the command from the tool directory.

```powershell
node .\make-patches.mjs .\stock-games .\patches
```

Replace `.\stock-games` with the directory of a game that has its original scripts, or with a directory containing several such games. The generator skips a game if its scripts already contain a dialogue stop disabled by the patch. The second argument must be a new output directory. If a write fails, the generator cleans up the output it created so the command can be retried.

- `report.json` lists the detected installations and their results.
- `games/<installation>/patched/spt` contains the modified scripts.
- `games/<installation>/original/spt` contains backups of those scripts.
- Each game package includes a `manifest.json` with the engine layout, detected instruction locations, and executable and script hashes.

## Apply or restore

1. Close the game and locate its package using `report.json`.
2. Copy the `.spt` files from `patched/spt` to the `spt` directory in a copy of the game, replacing the matching files.
3. To restore the stock scripts, copy the matching files from `original/spt` back to the same directory. If you saved a `before-install/spt` snapshot, copy those files back to restore the exact pre-update state.

To check playback in-game, advance from a playing voiced line to a page with only text or a voice sound effect. The dialogue should keep playing. Advance to the next line with ordinary dialogue on the same channel to check that it replaces the previous one.

## Engine detection and patching

1. [The engine detector](nnn-engine.mjs) searches executable sections of each 32-bit Windows EXE for the NNN interpreter's record-skip code and the voice command dispatcher. It follows their relative branch and call offsets and checks for the expected skip operation and `-1` stop branch.
2. The generator reads the SPT headers and matches a channel-0 stop to the following text by message index. It allows ordinary sound effects and `soundvoice` commands on channels 2 and 3 in the same group. It changes the channel-0 stop to the interpreter's skip type and preserves the record length and offsets.
3. The output records the executable and script SHA-256 values for identification. Compatibility is determined by engine instructions and SPT structure.

The detector covers the interpreter layouts seen in the ten samples. A rebuild using different machine code may need an additional signature. The patch preserves the soundvoice commands themselves, groups that use the second dialogue channel, and stops outside matching text groups. Muted or missing voice files still follow the engine's behavior when it attempts to replace the current voice.

## Verification

The soundvoice revision skipped 2,186 additional channel-0 stops. The final 100 output scripts and all original backups were verified byte for byte. The installation hash check confirmed the revised output in all ten game directories. In-game listening tests remain pending. [Previous revision verification](patch-verification.json)

Run `node --test` from this directory to check engine detection and script patching.

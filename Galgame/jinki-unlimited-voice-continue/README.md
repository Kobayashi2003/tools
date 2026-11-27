# JINKI -Unlimited- Voice Continue

Keep the current ADV dialogue voice playing when advancing through unvoiced text. The next loaded dialogue voice takes over on the same channel. Effects played through `SoundCompPlay` use separate components. Explicit `StopVoice` and stop-all commands still work.

## Supported build

The generator supports the inspected Windows release of JINKI -Unlimited-. It checks the SHA-256 hashes of both original `BP_NovelComp` files before writing the patch. The [analysis notes](analysis.md) list the asset hashes and the two Blueprint statements it changes.

## Build

Run these commands from this project directory with uv, Python 3.11 or newer, and repak v0.2.3. Set the game and repak paths for your installation.

```powershell
$null = New-Item -ItemType Directory -Path '.\output' -Force
uv run .\build_patch.py 'C:\Games\JINKI -Unlimited-' --repak '.\path\to\repak.exe' --output '.\output\JinkiVoiceContinue_P.pak'
```

The output directory must exist and the destination PAK must be new. Without `--output`, the generator writes `JinkiVoiceContinue_P.pak` in the current directory.

## Install and restore

1. Close the game.
2. If `JinkiVoiceContinue_P.pak` is already installed, save a copy with a `.bak` extension.
3. Copy `output/JinkiVoiceContinue_P.pak` into `JinkiUnlimited/Content/Paks/` under the game directory.
4. Restart the game. To revert, close the game and remove that PAK. To restore an earlier patch, copy its backup over the installed PAK.

## Verification

A fresh build from this project matched the installed PAK byte for byte. Package inspection verified both jump targets and the original `VoicePlay` and explicit `StopVoice` handlers. To check playback, advance from a voiced line through unvoiced text and a sound effect, then advance to the next voiced line.

## Development checks

Run these commands from the project directory.

```powershell
uvx ruff check
uvx ruff format --check
uvx basedpyright
```

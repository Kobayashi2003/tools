# JINKI -Unlimited- Gallery

`JinkiGallery_P.pak` adds one **Gallery** entry to the title screen alongside **Option**. The gallery has a dark blue layout, a scrollable CG grid, and two replay lists with the game's Japanese scene titles.

| Tab | Available entries |
| --- | --- |
| **CG** | All 52 original CG entries, including their image variants. Select a thumbnail to open the full-size viewer and right-click to return to the grid. The mission base CG gallery is also unlocked. |
| **Scene** | 342 standalone ADV excerpts, including defeat episodes without an event CG. |
| **Defeat** | 22 defeat episodes with event CGs. Each card shows the first event CG used by that episode. |

All entries are available immediately. [SceneCatalog.tsv](SceneCatalog.tsv) lists the replay IDs, script names, categories, titles, and defeat thumbnail keys.

## Supported build

Use the Windows release whose original `pakchunk0-WindowsNoEditor.pak` has SHA-256 `c361099a198d152d8aabb2caccef9e9fa9014858d099bd2ffa89bcad6eeffd7e`.

## Build

Run the following in PowerShell 7 from this project directory. Use the .NET 8 SDK and [repak v0.2.3](https://github.com/trumank/repak/releases/tag/v0.2.3). NuGet restores [UAssetAPI v1.1.0](https://www.nuget.org/packages/UAssetAPI/1.1.0) using `packages.lock.json`. Set the two input paths for your installation. Use fresh `work/extracted` and `work/overlay` directories.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$sourcePak = 'C:\Games\JINKI -Unlimited-\JinkiUnlimited\Content\Paks\pakchunk0-WindowsNoEditor.pak'
$repak = 'C:\path\to\repak.exe'
$vn = 'JinkiUnlimited/Plugins/VN_Plugin/Content/VN_Plus'
$trex = 'JinkiUnlimited/Content/T_Rex'
$extracted = Join-Path $PWD.Path 'work\extracted'
$overlay = Join-Path $PWD.Path 'work\overlay'
$null = New-Item -ItemType Directory -Path '.\output' -Force

dotnet restore --locked-mode
dotnet build --configuration Release --no-restore
& $repak unpack -q -o $extracted -i "$vn/BluePrint" -i "$vn/DataTable/Script/setting" `
  -i "$trex/Blueprints/UI/Title" -i "$trex/Blueprints/UI/Recollection" `
  -i "$trex/DataTable/DataTable/DT_Story_Master.uasset" `
  -i "$trex/DataTable/DataTable/DT_Story_Master.uexp" -i "$trex/DataTable/Script" $sourcePak
dotnet .\bin\Release\net8.0\GalleryPatch.dll $extracted $overlay |
  Set-Content -Encoding utf8 .\work\SceneCatalog.tsv
& $repak pack -q --version V11 $overlay .\output\JinkiGallery_P.pak
```

The output to install is `output/JinkiGallery_P.pak`. The build writes a fresh catalogue to `work/SceneCatalog.tsv`. Update the versioned catalogue when replay entries or thumbnail keys change. Extracted assets, intermediate files, and generated PAKs go in ignored directories.

## Install and restore

1. Close the game.
2. If an earlier `JinkiGallery_P.pak` is installed, copy it to a backup with a `.bak` extension.
3. Copy `output/JinkiGallery_P.pak` into `JinkiUnlimited/Content/Paks/` under the game directory.
4. Start the game and choose **Gallery**. The title menu appears after the initial **Press Any Button** screen.

The voice continuation PAK can be installed alongside this PAK. To restore the previous gallery version, copy the backup over `JinkiGallery_P.pak` while the game is closed.

## Playback and verification

The replay catalogue uses segments starting at the authored entry label that contain dialogue and reach a known endpoint using presentation commands. Entries with combat, map loads, branch commands, or other dependencies before that endpoint are omitted. An unconditional jump to another indexed episode in the defeat arc ends the current excerpt. Each excerpt runs from a dedicated script copy with `EndSceneGallery` as its last command. This command returns to the title map.

Replay titles come from the game's story table. The generator identifies defeat candidates from the game's defeat arc and defeat-related story titles. For each candidate, it scans the excerpt's `Texture` commands in script order and resolves their keys through the original texture table. The first key in the event CG directory supplies the thumbnail. Candidates without a matching CG appear under **Scene**. Backgrounds and black screens do not count as event CGs.

The VN save and CG flag handlers are guarded during replay. CG availability is computed when the gallery opens, so opening it does not write unlock flags to the save.

An isolated Windows copy was used to check the title entry, CG grid, full-size viewer, and replay lists. The defeat card layout was checked in a test package with sample images. Package inspection confirmed all 364 replay references and exit commands. It also checked all 22 installed thumbnail references against the first event CG in each original script.

The patch reuses the game's shipped UMG widgets and runs excerpts through the existing visual-novel player. [Unreal Engine 4.27 widget documentation](https://dev.epicgames.com/documentation/en-us/unreal-engine/creating-widgets?application_version=4.27)

## Development checks

Run these commands from the project directory.

```powershell
dotnet restore --locked-mode
dotnet build --configuration Release --no-restore
dotnet format whitespace --no-restore --verify-no-changes
```

# ADV voice playback analysis

The inspected package is a UE4 version 11 PAK with mount point `../../../`. `BP_NovelComp` and `BP_SoundComp` are cooked assets from `VN_Plugin`. The shipped manual's Sound configuration lists Voice volume. The two call sites below are in the game's Blueprint VM.

| Function and VM offset | Stock behavior | Patch |
| --- | --- | --- |
| `BP_NovelComp.ExecuteUbergraph` at `0xA30D` | Calls `StopVoiceCommand("")` on the path without a voice asset. | Jump to `0xA333`. |
| `BP_NovelComp.ExecuteUbergraph` at `0xA74B` | Calls `StopVoiceCommand("")` after checking the missing voice and `ClickSoundFlag`. | Jump to `0xA771`. |
| `BP_NovelComp.ExecuteUbergraph` at `0xADA5` | Handles the explicit `StopVoice` command and passes the script's argument for stop or fade-out. | Original statement. |
| `BP_NovelComp.ExecuteUbergraph` at `0xC74D` | Passes the loaded `SoundCue` and lip-sync target to `VoicePlay`. | Original statement. |

Each jump skips unreachable valid instructions so the original 42-byte serialized span and 38-byte VM span are preserved. The patched package retains the `.uasset` header byte for byte.

In `BP_SoundComp`, the `VoicePlay` entry at `0x2806` selects the playback path, and `0x27AD` stops the current `VoiceSound` on that path before creating and playing a new component. The handover therefore happens when the Blueprint handles the loaded cue, before the audio device emits the next line. `SoundCompPlay` uses the separate SE, BGM, or ambient branch. The ordinary voice and effects paths are distinguished by the command or field used by the script. `VoicePlay` can also be invoked from backlog playback.

The analysis used the shipped asset names and bytecode, repak v0.2.3 for archive access, and UAssetAPI v1.1.0 for decoding Kismet. The original game booted into the opening ADV scene in an isolated copy. The patched package was verified statically.

| Input | SHA-256 |
| --- | --- |
| `JinkiUnlimited-Win64-Shipping.exe` | `8c47a8d7ad50245d52bf07a34e56d16f8572eca2578079c7e5fe71f7b922c8db` |
| `BP_NovelComp.uasset` | `97238013877cd52c5ab34c14f7cc9b3da6a8951027c286d1b4749cfe315cf950` |
| `BP_NovelComp.uexp` | `1721216cf36c4fa6f27de5f5edb20860a59a15b4b56a2f49ab3cfd2b35bda06e` |

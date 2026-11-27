"""Build a removable Voice Continue PAK from a supported game installation."""

import argparse
import hashlib
import struct
import subprocess
from pathlib import Path
from tempfile import TemporaryDirectory

BASE_PAK = Path("JinkiUnlimited/Content/Paks/pakchunk0-WindowsNoEditor.pak")
ASSET = Path(
    "JinkiUnlimited/Plugins/VN_Plugin/Content/VN_Plus/BluePrint/"
    "Character/Component/BP_NovelComp.uasset"
)
OUTPUT_NAME = "JinkiVoiceContinue_P.pak"
ASSET_SHA256 = "97238013877cd52c5ab34c14f7cc9b3da6a8951027c286d1b4749cfe315cf950"
EXPORT_SHA256 = "1721216cf36c4fa6f27de5f5edb20860a59a15b4b56a2f49ab3cfd2b35bda06e"

# Context(SoundConponent, LocalVirtualFunction(StopVoiceCommand, ""))
# This statement occupies 42 bytes on disk and 38 bytes in the Blueprint VM.
IMPLICIT_STOP = bytes.fromhex(
    "190101000000370300000000000075000000100000000000000000000000"
    "4569030000000000001f0016"
)


def patch_export(data: bytes) -> bytes:
    if hashlib.sha256(data).hexdigest() != EXPORT_SHA256:
        raise ValueError("This BP_NovelComp.uexp build is not supported")

    first = data.find(IMPLICIT_STOP)
    second = data.find(IMPLICIT_STOP, first + len(IMPLICIT_STOP))
    if (
        first < 0
        or second < 0
        or data.find(IMPLICIT_STOP, second + len(IMPLICIT_STOP)) >= 0
    ):
        raise ValueError("Expected exactly two implicit voice-stop statements")

    # Keep the serialized span and VM span intact with unreachable, valid tokens.
    # InstanceVariable is 17/9 bytes, NameConst is 9/13, and each Nothing is 1/1.
    instance_variable = IMPLICIT_STOP[1:18]
    name_const = b"\x21" + IMPLICIT_STOP[31:39]
    padding = instance_variable + name_const + b"\x0b" * 11

    patched = bytearray(data)
    for offset, resume_at in ((first, 0xA333), (second, 0xA771)):
        jump = struct.pack("<BI", 0x06, resume_at)
        patched[offset : offset + len(IMPLICIT_STOP)] = jump + padding
    return bytes(patched)


def build(game_root: Path, repak: Path, output: Path) -> None:
    source = game_root / BASE_PAK
    if not source.is_file():
        raise ValueError("Cannot find the base PAK in the supplied game directory")
    if output.exists():
        raise ValueError("The output file already exists")

    with TemporaryDirectory(prefix="jinki-voice-", dir=output.parent) as directory:
        work = Path(directory)
        extracted = work / "assets"
        export = ASSET.with_suffix(".uexp")
        for path in (ASSET, export):
            dest = extracted / path
            dest.parent.mkdir(parents=True, exist_ok=True)
            with dest.open("wb") as file:
                subprocess.run(
                    [repak, "get", source, path.as_posix()], stdout=file, check=True
                )

        if hashlib.sha256((extracted / ASSET).read_bytes()).hexdigest() != ASSET_SHA256:
            raise ValueError("This BP_NovelComp.uasset build is not supported")
        dest = extracted / export
        dest.write_bytes(patch_export(dest.read_bytes()))

        pak = work / output.name
        subprocess.run(
            [repak, "pack", "-q", "--version", "V11", extracted, pak], check=True
        )
        pak.rename(output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("game_root", type=Path, help="JINKI -Unlimited- game directory")
    parser.add_argument("--repak", type=Path, required=True, help="Path to repak.exe")
    parser.add_argument(
        "--output",
        type=Path,
        default=Path(OUTPUT_NAME),
        help="New PAK path (default: %(default)s)",
    )
    args = parser.parse_args()
    try:
        build(args.game_root, args.repak.resolve(), args.output.resolve())
    except (OSError, ValueError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Patch build failed: {error}\n")


if __name__ == "__main__":
    main()

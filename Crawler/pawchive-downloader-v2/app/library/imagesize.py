"""Pixel dimensions from a file header. Fanbox gives an image's width and height but
not its size, so the dimensions are how a downloaded or adopted image is checked."""

import struct
from pathlib import Path


def image_size(path: Path) -> tuple[int, int] | None:
    try:
        with open(path, "rb") as f:
            head = f.read(32)
            if head.startswith(b"\x89PNG\r\n\x1a\n") and head[12:16] == b"IHDR":
                w, h = struct.unpack(">II", head[16:24])
                return w, h
            if head[:6] in (b"GIF87a", b"GIF89a"):
                w, h = struct.unpack("<HH", head[6:10])
                return w, h
            if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
                return _webp(head, f)
            if head[:2] == b"\xff\xd8":
                f.seek(2)
                return _jpeg(f)
    except OSError:
        return None
    return None


def _webp(head: bytes, f) -> tuple[int, int] | None:
    f.seek(12)
    chunk = f.read(4)
    data = f.read(26)
    if chunk == b"VP8X" and len(data) >= 14:
        w = int.from_bytes(data[8:11], "little") + 1
        h = int.from_bytes(data[11:14], "little") + 1
        return w, h
    if chunk == b"VP8 " and len(data) >= 14:
        w, h = struct.unpack("<HH", data[10:14])
        return w & 0x3FFF, h & 0x3FFF
    if chunk == b"VP8L" and len(data) >= 9:
        bits = int.from_bytes(data[5:9], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    return None


def _jpeg(f) -> tuple[int, int] | None:
    while True:
        marker = f.read(2)
        if len(marker) < 2 or marker[0] != 0xFF:
            return None
        kind = marker[1]
        if kind in (0xD8, 0x01) or 0xD0 <= kind <= 0xD7:
            continue
        length_bytes = f.read(2)
        if len(length_bytes) < 2:
            return None
        length = struct.unpack(">H", length_bytes)[0]
        # SOF markers carry the frame size; C4, C8 and CC are not frames.
        if 0xC0 <= kind <= 0xCF and kind not in (0xC4, 0xC8, 0xCC):
            data = f.read(5)
            if len(data) < 5:
                return None
            h, w = struct.unpack(">HH", data[1:5])
            return w, h
        f.seek(length - 2, 1)

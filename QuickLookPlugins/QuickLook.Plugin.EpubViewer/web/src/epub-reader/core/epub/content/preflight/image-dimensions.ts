import type { IntrinsicViewport } from '../../publication';

/** Read common raster headers without pulling browser imaging APIs into core. */
export function imageDimensions(
  bytes: Uint8Array,
): IntrinsicViewport | undefined {
  return pngDimensions(bytes) ?? gifDimensions(bytes) ?? jpegDimensions(bytes);
}

function pngDimensions(bytes: Uint8Array): IntrinsicViewport | undefined {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return validViewport(view.getUint32(16, false), view.getUint32(20, false));
}

function gifDimensions(bytes: Uint8Array): IntrinsicViewport | undefined {
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46
  ) {
    return undefined;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return validViewport(view.getUint16(6, true), view.getUint16(8, true));
}

function jpegDimensions(bytes: Uint8Array): IntrinsicViewport | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
    return undefined;

  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    const marker = bytes[offset + 1]!;
    offset += 2;
    if (isStandaloneJpegMarker(marker)) continue;
    if (offset + 2 > bytes.length) break;

    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (isStartOfFrameMarker(marker) && segmentLength >= 7) {
      const height = (bytes[offset + 3]! << 8) | bytes[offset + 4]!;
      const width = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      return validViewport(width, height);
    }
    offset += segmentLength;
  }
  return undefined;
}

function isStandaloneJpegMarker(marker: number): boolean {
  return (
    marker === 0xd8 ||
    marker === 0xd9 ||
    marker === 0x01 ||
    (marker >= 0xd0 && marker <= 0xd7)
  );
}

function isStartOfFrameMarker(marker: number): boolean {
  return (
    (marker >= 0xc0 && marker <= 0xc3) ||
    (marker >= 0xc5 && marker <= 0xc7) ||
    (marker >= 0xc9 && marker <= 0xcb) ||
    (marker >= 0xcd && marker <= 0xcf)
  );
}

function validViewport(
  width: number,
  height: number,
): IntrinsicViewport | undefined {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

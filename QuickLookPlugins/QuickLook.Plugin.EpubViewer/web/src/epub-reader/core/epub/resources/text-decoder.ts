/**
 * Decode textual publication resources without assuming every malformed EPUB is
 * UTF-8. EPUB 3 strongly favors Unicode encodings, but old/invalid books exist.
 * BOMs win; CSS @charset is honored when present; otherwise UTF-8 is used.
 */
export function decodePublicationText(
  bytes: Uint8Array,
  mediaType: string,
): string {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    // TextDecoder support for utf-16be is widespread in browsers implementing
    // the Encoding Standard; keep a manual fallback for test/runtime parity.
    try {
      return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    } catch {
      const swapped = bytes.subarray(2).slice();
      for (let i = 0; i + 1 < swapped.length; i += 2) {
        const a = swapped[i]!;
        swapped[i] = swapped[i + 1]!;
        swapped[i + 1] = a;
      }
      return new TextDecoder('utf-16le').decode(swapped);
    }
  }

  if (mediaType.split(';', 1)[0]!.trim().toLowerCase() === 'text/css') {
    const asciiPrefix = new TextDecoder('ascii').decode(
      bytes.subarray(0, Math.min(bytes.length, 256)),
    );
    const match = /^\s*@charset\s+["']([^"']+)["']\s*;/i.exec(asciiPrefix);
    if (match?.[1]) {
      try {
        return new TextDecoder(match[1]).decode(bytes);
      } catch {
        // Invalid/unsupported declarations degrade to UTF-8. Diagnostics belong
        // to the resolver, which has publication/path context.
      }
    }
  }

  return new TextDecoder('utf-8').decode(bytes);
}

/** Stable publication identity used by host persistence adapters. */
export function publicationSessionKey(
  bytes: Uint8Array | ArrayBuffer,
  sourceName = 'publication',
): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const normalizedName = sourceName.trim().toLowerCase() || 'publication';
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const update = (byte: number, index: number) => {
    first = Math.imul(first ^ byte, 0x01000193) >>> 0;
    second = Math.imul(second ^ (byte + index), 0x85ebca6b) >>> 0;
  };
  // Hash every byte. Sampling only the head and tail made two same-sized EPUBs
  // with identical ZIP edges share a session even when their content differed.
  for (let index = 0; index < view.length; index += 1)
    update(view[index]!, index);
  const nameHash = [...normalizedName].reduce(
    (hash, char) => Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0,
    0x811c9dc5,
  );
  return `${view.length.toString(36)}-${nameHash.toString(36)}-${first.toString(36)}${second.toString(36)}`;
}

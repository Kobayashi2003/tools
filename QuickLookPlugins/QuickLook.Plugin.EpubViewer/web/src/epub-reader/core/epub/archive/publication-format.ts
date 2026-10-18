import { openKf8Archive } from './kf8-archive';
import {
  DEFAULT_OCF_ZIP_LIMITS,
  OcfZipArchive,
  type OcfCompatibilityMode,
  type OcfZipLimits,
} from './ocf-zip';
import type { PublicationArchiveOpenResult } from './publication-archive';

export type PublicationContainerFormat = 'ocf-zip' | 'mobi' | 'unknown';

/**
 * Identify a publication container from its leading bytes without parsing it.
 * A Kindle MOBI/AZW3 file is a Palm database whose type and creator fields at
 * offset 60 read `BOOKMOBI`.
 */
export function detectPublicationFormat(
  bytes: Uint8Array,
): PublicationContainerFormat {
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)
  )
    return 'ocf-zip';
  if (bytes.length >= 68 && ascii(bytes, 60, 68) === 'BOOKMOBI') return 'mobi';
  return 'unknown';
}

/**
 * Open the archive behind a publication. This is the single entry for every
 * container format: each adapter presents the same `PublicationArchive`
 * contract so loading, compatibility and rendering stay format-independent.
 */
export async function openPublicationArchive(
  input: Uint8Array | ArrayBuffer,
  limits: Partial<OcfZipLimits> = {},
  mode: OcfCompatibilityMode = 'compatible',
): Promise<PublicationArchiveOpenResult> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (detectPublicationFormat(bytes) === 'mobi')
    return openKf8Archive(bytes, { ...DEFAULT_OCF_ZIP_LIMITS, ...limits });
  return OcfZipArchive.open(bytes, limits, mode);
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

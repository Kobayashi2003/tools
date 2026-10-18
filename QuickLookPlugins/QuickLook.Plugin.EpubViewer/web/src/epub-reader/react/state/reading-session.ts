import { publicationSessionKey, type ReadingSessionStorage } from '../../core';
import type { EpubSource } from './model';

export interface ReadingSessionOptions {
  readonly key?: string;
  readonly storage?: ReadingSessionStorage;
  readonly persistPreferences?: boolean;
  readonly saveDelayMs?: number;
}

export function readingSessionKey(
  source: EpubSource,
  bytes: Uint8Array | ArrayBuffer,
): string {
  return publicationSessionKey(
    bytes,
    isNamedSource(source) ? source.name : undefined,
  );
}

function isNamedSource(
  source: EpubSource,
): source is EpubSource & { readonly name: string } {
  return typeof (source as { readonly name?: unknown }).name === 'string';
}

import type { Publication } from '../../../core';

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_PREFIX = 'epub-reader:contents:collapsed:';

export function publicationContentsKey(publication: Publication): string {
  const identity =
    publication.metadata.identifier?.value || publication.packagePath;
  return `${identity}:${publication.spine.length}`;
}

export function readCollapsedSections(
  publicationKey: string,
): ReadonlySet<string> {
  const storage = browserSessionStorage();
  if (!storage) return new Set();
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(storageKey(publicationKey)) ?? '[]',
    );
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((value): value is string => typeof value === 'string')
        : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsedSections(
  publicationKey: string,
  collapsed: ReadonlySet<string>,
): void {
  const storage = browserSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(storageKey(publicationKey), JSON.stringify([...collapsed]));
  } catch {
    // A denied or full session store must not make publication navigation fail.
  }
}

function storageKey(publicationKey: string): string {
  return `${STORAGE_PREFIX}${encodeURIComponent(publicationKey)}`;
}

function browserSessionStorage(): SessionStorageLike | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

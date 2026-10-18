import type {
  PublicationDiagnostic,
  PublicationPath,
} from '../publication/model';
import { validateArchiveEntryPath } from '../publication/path';

export interface PublicationArchive {
  readonly entries: readonly PublicationPath[];
  has(path: PublicationPath): boolean;
  read(path: PublicationPath): Promise<Uint8Array>;
  readText(path: PublicationPath, encoding?: string): Promise<string>;
}

/** An opened archive of any container format, or the reasons it failed. */
export interface PublicationArchiveOpenResult {
  readonly archive: PublicationArchive | null;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export class MemoryPublicationArchive implements PublicationArchive {
  readonly entries: readonly PublicationPath[];
  private readonly files: ReadonlyMap<PublicationPath, Uint8Array>;

  constructor(files: Readonly<Record<string, Uint8Array | string>>) {
    const encoder = new TextEncoder();
    const normalized = new Map<PublicationPath, Uint8Array>();
    for (const [path, value] of Object.entries(files)) {
      const key = validateArchiveEntryPath(path);
      normalized.set(
        key,
        typeof value === 'string' ? encoder.encode(value) : value,
      );
    }
    this.files = normalized;
    this.entries = [...normalized.keys()];
  }

  has(path: PublicationPath): boolean {
    try {
      return this.files.has(validateArchiveEntryPath(path));
    } catch {
      return false;
    }
  }

  async read(path: PublicationPath): Promise<Uint8Array> {
    const safePath = validateArchiveEntryPath(path);
    const value = this.files.get(safePath);
    if (!value) throw new Error(`Archive entry not found: ${safePath}`);
    return value.slice();
  }

  async readText(path: PublicationPath, encoding = 'utf-8'): Promise<string> {
    return new TextDecoder(encoding).decode(await this.read(path));
  }
}

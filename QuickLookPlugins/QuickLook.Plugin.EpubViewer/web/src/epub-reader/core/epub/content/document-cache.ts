import type { SpineItem } from '../publication';
import type { MaterializedContentDocument } from './model';
import type { PublicationContentDocumentPipeline } from './content-document-pipeline';

export interface PublicationContentDocumentCachePolicy {
  /** Maximum number of fully materialized spine documents retained. */
  readonly maxDocuments: number;
  /** Approximate UTF-16 markup bytes retained across ready documents. */
  readonly maxBytes: number;
}

export const DEFAULT_PUBLICATION_CONTENT_DOCUMENT_CACHE_POLICY: PublicationContentDocumentCachePolicy =
  Object.freeze({
    maxDocuments: 8,
    maxBytes: 8 * 1024 * 1024,
  });

export interface PublicationContentDocumentCacheOptions {
  readonly policy?: Partial<PublicationContentDocumentCachePolicy>;
  /** Keeps the active document and its immediate neighbours resident when possible. */
  readonly preferredSpineIndex?: () => number | null;
}

export type PublicationContentDocumentMaterializer = (
  item: SpineItem,
) => Promise<MaterializedContentDocument>;

export interface PublicationContentDocumentCacheSnapshot {
  readonly readyDocuments: number;
  readonly pendingDocuments: number;
  readonly approximateBytes: number;
  readonly keys: readonly string[];
}

interface PendingCacheEntry {
  readonly state: 'pending';
  readonly spineIndex: number;
  readonly promise: Promise<MaterializedContentDocument>;
  lastAccess: number;
}

interface ReadyCacheEntry {
  readonly state: 'ready';
  readonly spineIndex: number;
  readonly document: MaterializedContentDocument;
  readonly bytes: number;
  lastAccess: number;
}

type CacheEntry = PendingCacheEntry | ReadyCacheEntry;

/**
 * Publication-scoped cache for immutable, rewritten content documents.
 *
 * It deliberately retains serialized markup rather than live DOM/iframe state:
 * renderers remain one-document instances while returning to a recent chapter
 * avoids repeating archive reads, parsing, resource rewriting and serialization.
 * Object URLs stay owned by PublicationResourceSession and are revoked together
 * when that session is disposed.
 */
export class PublicationContentDocumentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly policy: PublicationContentDocumentCachePolicy;
  private accessClock = 0;
  private approximateBytes = 0;
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly pipeline: PublicationContentDocumentPipeline,
    private readonly options: PublicationContentDocumentCacheOptions = {},
    private readonly materializer?: PublicationContentDocumentMaterializer,
  ) {
    this.policy = normalizePolicy(options.policy);
  }

  async materialize(item: SpineItem): Promise<MaterializedContentDocument> {
    this.assertAlive();
    const key = contentDocumentCacheKey(item, this.pipeline.renderSignature);
    const existing = this.entries.get(key);
    if (existing) {
      existing.lastAccess = ++this.accessClock;
      return existing.state === 'ready' ? existing.document : existing.promise;
    }

    const generation = this.generation;
    const promise = this.load(item).then(freezeMaterializedDocument);
    const pending: PendingCacheEntry = {
      state: 'pending',
      spineIndex: item.index,
      promise,
      lastAccess: ++this.accessClock,
    };
    this.entries.set(key, pending);

    try {
      const document = await promise;
      if (
        !this.disposed &&
        generation === this.generation &&
        this.entries.get(key) === pending
      ) {
        const bytes = approximateDocumentBytes(document);
        this.entries.set(key, {
          state: 'ready',
          spineIndex: item.index,
          document,
          bytes,
          lastAccess: pending.lastAccess,
        });
        this.approximateBytes += bytes;
        this.trim();
      }
      return document;
    } catch (error) {
      if (this.entries.get(key) === pending) this.entries.delete(key);
      throw error;
    }
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.approximateBytes = 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
  }

  get snapshot(): PublicationContentDocumentCacheSnapshot {
    let readyDocuments = 0;
    let pendingDocuments = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === 'ready') readyDocuments += 1;
      else pendingDocuments += 1;
    }
    return Object.freeze({
      readyDocuments,
      pendingDocuments,
      approximateBytes: this.approximateBytes,
      keys: Object.freeze([...this.entries.keys()]),
    });
  }

  private load(item: SpineItem): Promise<MaterializedContentDocument> {
    return (
      this.materializer?.(item) ?? this.pipeline.materializeForRender(item)
    );
  }

  private trim(): void {
    while (
      this.readyCount() > this.policy.maxDocuments ||
      this.approximateBytes > this.policy.maxBytes
    ) {
      const candidate = this.evictionCandidate();
      if (!candidate) break;
      const [key, entry] = candidate;
      this.entries.delete(key);
      this.approximateBytes -= entry.bytes;
    }
  }

  private readyCount(): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === 'ready') count += 1;
    }
    return count;
  }

  private evictionCandidate(): readonly [string, ReadyCacheEntry] | null {
    const preferred = this.options.preferredSpineIndex?.() ?? null;
    let fallback: [string, ReadyCacheEntry] | null = null;
    let unpreferred: [string, ReadyCacheEntry] | null = null;

    for (const [key, entry] of this.entries) {
      if (entry.state !== 'ready') continue;
      if (!fallback || entry.lastAccess < fallback[1].lastAccess)
        fallback = [key, entry];
      const protectedByProximity =
        preferred != null && Math.abs(entry.spineIndex - preferred) <= 1;
      if (
        !protectedByProximity &&
        (!unpreferred || entry.lastAccess < unpreferred[1].lastAccess)
      ) {
        unpreferred = [key, entry];
      }
    }
    return unpreferred ?? fallback;
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('PublicationContentDocumentCache has been disposed.');
  }
}

function contentDocumentCacheKey(
  item: SpineItem,
  profileSignature: string,
): string {
  const mediaType = item.mediaType.split(';', 1)[0]?.trim().toLowerCase();
  const variant = mediaType === 'image/svg+xml' ? 'svg' : 'xhtml';
  return `${item.index}:${item.path ?? item.href}:${variant}:${profileSignature}`;
}

function normalizePolicy(
  input: Partial<PublicationContentDocumentCachePolicy> | undefined,
): PublicationContentDocumentCachePolicy {
  const maxDocuments = normalizeLimit(
    input?.maxDocuments,
    DEFAULT_PUBLICATION_CONTENT_DOCUMENT_CACHE_POLICY.maxDocuments,
  );
  const maxBytes = normalizeLimit(
    input?.maxBytes,
    DEFAULT_PUBLICATION_CONTENT_DOCUMENT_CACHE_POLICY.maxBytes,
  );
  return Object.freeze({ maxDocuments, maxBytes });
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : fallback;
}

function freezeMaterializedDocument(
  document: MaterializedContentDocument,
): MaterializedContentDocument {
  return Object.freeze({
    ...document,
    hints: Object.freeze({ ...document.hints }),
    diagnostics: Object.freeze([...document.diagnostics]),
  });
}

function approximateDocumentBytes(
  document: MaterializedContentDocument,
): number {
  return Math.max(1, document.markup.length * 2);
}

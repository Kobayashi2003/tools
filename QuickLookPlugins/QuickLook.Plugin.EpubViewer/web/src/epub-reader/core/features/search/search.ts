import type {
  Publication,
  PublicationDiagnostic,
} from '../../epub/publication';
import { searchDocumentLocatorRange } from './location-index';
import type {
  PublicationSearchCachePolicy,
  PublicationSearchCacheSnapshot,
  SearchDocument,
  SearchDocumentProvider,
  SearchHit,
  SearchOptions,
  SearchResultSet,
} from './model';
import { DEFAULT_SEARCH_CACHE_POLICY, DEFAULT_SEARCH_OPTIONS } from './model';

interface SearchCacheEntry {
  readonly spineIndex: number;
  readonly controller: AbortController;
  promise: Promise<SearchDocument | null>;
  /** Undefined while pending; null is a resolved non-searchable resource. */
  document?: SearchDocument | null;
  estimatedBytes: number;
}

export interface PublicationSearchOptions {
  readonly cache?: Partial<PublicationSearchCachePolicy>;
  /** Current reading-order position; its neighbouring indexes survive LRU pressure first. */
  readonly preferredSpineIndex?: () => number | null;
  /** Immutable compatibility/content-pipeline identity included in every cache key. */
  readonly cacheVariant?: string;
}

export class PublicationSearch {
  private readonly documents = new Map<string, SearchCacheEntry>();
  private readonly cachePolicy: PublicationSearchCachePolicy;

  constructor(
    private readonly publication: Publication,
    private readonly provider: SearchDocumentProvider,
    private readonly options: PublicationSearchOptions = {},
  ) {
    this.cachePolicy = normalizeCachePolicy(options.cache);
  }

  get cacheSnapshot(): PublicationSearchCacheSnapshot {
    const entries = [...this.documents.entries()];
    return Object.freeze({
      documents: entries.filter(([, entry]) => entry.document !== undefined)
        .length,
      pending: entries.filter(([, entry]) => entry.document === undefined)
        .length,
      estimatedBytes: entries.reduce(
        (total, [, entry]) => total + entry.estimatedBytes,
        0,
      ),
      spineIndexes: Object.freeze(entries.map(([, entry]) => entry.spineIndex)),
    });
  }

  async search(
    query: string,
    options: Partial<SearchOptions> = {},
    signal: AbortSignal = new AbortController().signal,
  ): Promise<SearchResultSet> {
    const merged = { ...DEFAULT_SEARCH_OPTIONS, ...options };
    const config: SearchOptions = {
      ...merged,
      maxResults: Math.max(0, Math.floor(merged.maxResults)),
      excerptLength: Math.max(24, Math.floor(merged.excerptLength)),
    };
    const needle = query.trim();
    if (!needle) return { query, hits: [], truncated: false, diagnostics: [] };
    const diagnostics: PublicationDiagnostic[] = [];
    const hits: SearchHit[] = [];
    const sentinelLimit = Math.max(1, config.maxResults) + 1;

    for (const item of this.publication.spine) {
      throwIfAborted(signal);
      if (!config.includeNonLinear && !item.linear) continue;
      if (hits.length >= sentinelLimit) break;
      let document: SearchDocument | null;
      try {
        document = await this.loadDocument(item.index);
      } catch (cause) {
        if (isAbort(cause) || signal.aborted) throw cause;
        diagnostics.push({
          code: 'SEARCH_DOCUMENT_LOAD_FAILED',
          severity: 'warning',
          phase: 'feature',
          spineIndex: item.index,
          path: item.path,
          message: `Search skipped unreadable spine item ${item.href}.`,
          cause,
        });
        continue;
      }
      throwIfAborted(signal);
      if (!document || !document.text) continue;
      diagnostics.push(...(document.diagnostics ?? []));
      const remaining = sentinelLimit - hits.length;
      const matches = findMatches(document.text, needle, config, remaining);
      for (const match of matches) {
        const end = match.index + match.value.length;
        const excerpt = excerptAround(
          document.text,
          match.index,
          end,
          config.excerptLength,
        );
        hits.push({
          id: `search:${item.index}:${match.index}:${end}`,
          query: needle,
          spineIndex: document.spineIndex,
          href: document.href,
          range: searchDocumentLocatorRange(document, match.index, end),
          excerpt: excerpt.text,
          excerptMatchStart: excerpt.matchStart,
          excerptMatchEnd: excerpt.matchEnd,
          match: match.value,
        });
      }
      if (hits.length >= sentinelLimit) break;
    }
    const truncated = hits.length > config.maxResults;
    return {
      query: needle,
      hits: truncated ? hits.slice(0, config.maxResults) : hits,
      truncated,
      diagnostics,
    };
  }

  /** Releases resolved indexes and aborts any index construction still in flight. */
  clearCache(): void {
    for (const entry of this.documents.values()) {
      if (entry.document === undefined) {
        entry.controller.abort(
          new DOMException('Search cache cleared.', 'AbortError'),
        );
      }
    }
    this.documents.clear();
  }

  private loadDocument(spineIndex: number): Promise<SearchDocument | null> {
    const key = this.cacheKey(spineIndex);
    let entry = this.documents.get(key);
    if (!entry) {
      // Parsing is publication-scoped rather than query-scoped. Let one shared
      // load finish even if a particular query is superseded, then reuse it.
      const controller = new AbortController();
      entry = {
        spineIndex,
        controller,
        promise: Promise.resolve(null),
        estimatedBytes: 0,
      };
      const current = entry;
      current.promise = this.provider.load(spineIndex, controller.signal).then(
        (document) => {
          if (this.documents.get(key) !== current) return document;
          current.document = document;
          current.estimatedBytes = document
            ? estimateSearchDocumentBytes(document)
            : 0;
          this.touch(key, current);
          this.trimCache();
          return document;
        },
        (error) => {
          if (this.documents.get(key) === current) this.documents.delete(key);
          throw error;
        },
      );
      this.documents.set(key, current);
    } else {
      this.touch(key, entry);
    }
    return entry.promise;
  }

  private touch(key: string, entry: SearchCacheEntry): void {
    if (this.documents.get(key) !== entry) return;
    this.documents.delete(key);
    this.documents.set(key, entry);
  }

  private trimCache(): void {
    while (this.exceedsCachePolicy()) {
      const candidate = this.evictionCandidate();
      if (candidate == null) return;
      this.documents.delete(candidate);
    }
  }

  private exceedsCachePolicy(): boolean {
    let documents = 0;
    let bytes = 0;
    for (const entry of this.documents.values()) {
      if (entry.document === undefined) continue;
      documents += 1;
      bytes += entry.estimatedBytes;
    }
    return (
      documents > this.cachePolicy.maxDocuments ||
      bytes > this.cachePolicy.maxBytes
    );
  }

  private evictionCandidate(): string | null {
    const resolved = [...this.documents.entries()].filter(
      ([, entry]) => entry.document !== undefined,
    );
    if (resolved.length === 0) return null;
    const anchor = this.options.preferredSpineIndex?.();
    if (anchor != null && Number.isInteger(anchor)) {
      const preferred = new Set([anchor - 1, anchor, anchor + 1]);
      const outside = resolved.find(
        ([, entry]) => !preferred.has(entry.spineIndex),
      );
      if (outside) return outside[0];
    }
    return resolved[0]![0];
  }

  private cacheKey(spineIndex: number): string {
    return `${this.options.cacheVariant ?? 'search/default'}:${spineIndex}`;
  }
}

function normalizeCachePolicy(
  input: Partial<PublicationSearchCachePolicy> | undefined,
): PublicationSearchCachePolicy {
  return Object.freeze({
    maxDocuments: normalizeLimit(
      input?.maxDocuments,
      DEFAULT_SEARCH_CACHE_POLICY.maxDocuments,
    ),
    maxBytes: normalizeLimit(
      input?.maxBytes,
      DEFAULT_SEARCH_CACHE_POLICY.maxBytes,
    ),
  });
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === Number.POSITIVE_INFINITY) return value;
  return Number.isFinite(value) ? Math.max(0, Math.floor(value!)) : fallback;
}

function estimateSearchDocumentBytes(document: SearchDocument): number {
  let bytes = document.text.length * 2 + 96;
  for (const segment of document.segments) {
    bytes +=
      48 +
      segment.sourceBoundaries.length * 4 +
      (segment.dom?.path.length ?? 0) * 4;
    if (segment.fragment) bytes += segment.fragment.length * 2;
    if (segment.cfi) {
      for (const path of [segment.cfi.packagePath, segment.cfi.contentPath]) {
        bytes += 24 + path.steps.length * 16;
        for (const step of path.steps)
          bytes += (step.assertion?.length ?? 0) * 2;
        bytes += (path.textAssertion?.before?.length ?? 0) * 2;
        bytes += (path.textAssertion?.after?.length ?? 0) * 2;
      }
    }
  }
  return bytes;
}

interface Match {
  readonly index: number;
  readonly value: string;
}

function findMatches(
  text: string,
  query: string,
  options: SearchOptions,
  limit: number,
): Match[] {
  if (limit <= 0) return [];
  const flags = options.caseSensitive ? 'gu' : 'giu';
  const pattern = new RegExp(escapeRegExp(query), flags);
  const out: Match[] = [];
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? -1;
    const value = match[0] ?? '';
    if (index < 0 || !value) continue;
    if (options.wholeWord && !isWholeWord(text, index, index + value.length))
      continue;
    out.push({ index, value });
    if (out.length >= limit) break;
  }
  return out;
}

function isWholeWord(text: string, start: number, end: number): boolean {
  const left = codePointBefore(text, start);
  const right = codePointAt(text, end);
  return !isWordCharacter(left) && !isWordCharacter(right);
}

function codePointBefore(text: string, index: number): string {
  if (index <= 0) return '';
  const last = text.charCodeAt(index - 1);
  if (last >= 0xdc00 && last <= 0xdfff && index >= 2) {
    const first = text.charCodeAt(index - 2);
    if (first >= 0xd800 && first <= 0xdbff) return text.slice(index - 2, index);
  }
  return text[index - 1] ?? '';
}

function codePointAt(text: string, index: number): string {
  if (index >= text.length) return '';
  const value = text.codePointAt(index);
  return value == null ? '' : String.fromCodePoint(value);
}

function isWordCharacter(char: string): boolean {
  return char !== '' && /[\p{L}\p{N}\p{M}_]/u.test(char);
}

interface SearchExcerpt {
  readonly text: string;
  readonly matchStart: number;
  readonly matchEnd: number;
}

function excerptAround(
  text: string,
  start: number,
  end: number,
  maxLength: number,
): SearchExcerpt {
  const extent = Math.max(24, maxLength);
  // A match longer than the excerpt window leaves no room on either side, and a
  // negative lead would start the excerpt part-way through the match itself.
  const before = Math.max(0, Math.floor((extent - (end - start)) / 2));
  const from = Math.max(0, start - before);
  const to = Math.min(text.length, Math.max(end, from + extent));
  const prefix = from > 0 ? '…' : '';
  const suffix = to < text.length ? '…' : '';
  // The query is trimmed before matching, so its first and last characters are
  // non-whitespace. Normalizing the three regions independently preserves the
  // exact match boundary while still collapsing authored layout whitespace.
  const leading = text.slice(from, start).replace(/\s+/gu, ' ').trimStart();
  const matched = text.slice(start, end).replace(/\s+/gu, ' ');
  const trailing = text.slice(end, to).replace(/\s+/gu, ' ').trimEnd();
  const matchStart = prefix.length + leading.length;
  return {
    text: `${prefix}${leading}${matched}${trailing}${suffix}`,
    matchStart,
    matchEnd: matchStart + matched.length,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Search aborted.', 'AbortError');
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

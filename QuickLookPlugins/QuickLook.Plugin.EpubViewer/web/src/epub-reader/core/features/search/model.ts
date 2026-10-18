import type {
  LocatorDomPoint,
  LocatorRange,
  PublicationDiagnostic,
  PublicationHref,
} from '../../epub/publication';
import type { CfiPath } from '../../interaction/locator';

export interface SearchOptions {
  readonly caseSensitive: boolean;
  readonly wholeWord: boolean;
  readonly includeNonLinear: boolean;
  readonly maxResults: number;
  readonly excerptLength: number;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = Object.freeze({
  caseSensitive: false,
  wholeWord: false,
  includeNonLinear: false,
  maxResults: 500,
  excerptLength: 96,
});

export interface PublicationSearchCachePolicy {
  /** Maximum number of resolved chapter indexes retained. */
  readonly maxDocuments: number;
  /** Approximate UTF-16/index bytes retained across resolved chapter indexes. */
  readonly maxBytes: number;
}

export const DEFAULT_SEARCH_CACHE_POLICY: PublicationSearchCachePolicy =
  Object.freeze({
    maxDocuments: 12,
    maxBytes: 8 * 1024 * 1024,
  });

export interface PublicationSearchCacheSnapshot {
  readonly documents: number;
  readonly pending: number;
  readonly estimatedBytes: number;
  /** Oldest to newest, useful for diagnostics and deterministic tests. */
  readonly spineIndexes: readonly number[];
}

/** Pure-data locator seed for one semantic text node. It must never retain DOM. */
export interface SearchTextSegment {
  readonly start: number;
  readonly end: number;
  readonly sourceBoundaries: readonly number[];
  readonly cfi?: {
    readonly packagePath: CfiPath;
    readonly contentPath: CfiPath;
  };
  readonly fragment?: string;
  readonly dom?: LocatorDomPoint;
}

export interface SearchDocument {
  readonly spineIndex: number;
  readonly href: PublicationHref;
  readonly text: string;
  readonly diagnostics?: readonly PublicationDiagnostic[];
  /** Offset-to-locator data only; parsed Document/Text nodes are released after load. */
  readonly segments: readonly SearchTextSegment[];
}

export interface SearchDocumentProvider {
  load(spineIndex: number, signal: AbortSignal): Promise<SearchDocument | null>;
}

export interface SearchHit {
  readonly id: string;
  readonly query: string;
  readonly spineIndex: number;
  readonly href: PublicationHref;
  readonly range: LocatorRange;
  readonly excerpt: string;
  /** UTF-16 offsets inside `excerpt`; UI must not rediscover them through case folding. */
  readonly excerptMatchStart: number;
  readonly excerptMatchEnd: number;
  readonly match: string;
}

export interface SearchResultSet {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly truncated: boolean;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export interface ReaderSearchState {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly index: number;
  readonly searching: boolean;
  readonly truncated: boolean;
  readonly diagnostics: readonly PublicationDiagnostic[];
  readonly error: unknown | null;
}

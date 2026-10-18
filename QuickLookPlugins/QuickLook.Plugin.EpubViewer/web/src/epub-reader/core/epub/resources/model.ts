import type {
  ManifestItem,
  PublicationDiagnostic,
  PublicationHref,
  PublicationPath,
} from '../publication/model';

export type RemoteResourcePolicy = 'preserve' | 'block';
export type UnmanifestedResourcePolicy = 'allow' | 'warn' | 'block';

export interface ResourceResolverOptions {
  readonly remotePolicy?: RemoteResourcePolicy;
  readonly unmanifestedPolicy?: UnmanifestedResourcePolicy;
  readonly maxResourceBytes?: number;
}

export interface ResolvedResourceRequest {
  readonly source: string;
  readonly basePath: PublicationPath;
  readonly href: PublicationHref;
  readonly path?: PublicationPath;
  readonly query?: string;
  readonly fragment?: string;
  readonly remote: boolean;
  readonly manifestItem?: ManifestItem;
  readonly mediaType?: string;
}

export interface LocalPublicationResource extends ResolvedResourceRequest {
  readonly remote: false;
  readonly path: PublicationPath;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface ResourceResolveResult {
  readonly request: ResolvedResourceRequest | null;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export interface ResourceReadResult {
  readonly resource: LocalPublicationResource | null;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export interface MaterializedResource {
  readonly request: ResolvedResourceRequest;
  /** URL safe to place in a rendered document, or null when blocked/unavailable. */
  readonly url: string | null;
}

export interface MaterializeResult {
  readonly resource: MaterializedResource | null;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export interface ObjectUrlFactory {
  create(bytes: Uint8Array, mediaType: string): string;
  revoke(url: string): void;
}

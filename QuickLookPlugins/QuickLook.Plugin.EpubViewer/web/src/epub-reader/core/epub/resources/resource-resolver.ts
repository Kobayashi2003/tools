import type { PublicationArchive } from '../archive/publication-archive';
import { runBinaryResourceCompatibility } from '../compatibility/resource-runner';
import type { CompatibilityProfile } from '../compatibility/profile';
import type {
  ManifestItem,
  Publication,
  PublicationDiagnostic,
  PublicationPath,
} from '../publication/model';
import { resolvePublicationReference } from '../publication/path';
import { inferMediaType } from './mime';
import {
  IDPF_FONT_OBFUSCATION,
  loadContainerEncryption,
  type EncryptedResourceInfo,
} from './encryption';
import type {
  LocalPublicationResource,
  ResolvedResourceRequest,
  ResourceReadResult,
  ResourceResolveResult,
  ResourceResolverOptions,
} from './model';

const DEFAULT_MAX_RESOURCE_BYTES = 256 * 1024 * 1024;

/**
 * Safe, MIME-aware access to resources inside an opened EPUB publication.
 * Renderers depend on this service, never on ZIP internals.
 */
export interface ResourceResolverCreateResult {
  readonly resolver: ResourceResolver;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export class ResourceResolver {
  private readonly manifestByPath: ReadonlyMap<PublicationPath, ManifestItem>;
  private readonly manifestByHref: ReadonlyMap<string, ManifestItem>;
  readonly options: Required<ResourceResolverOptions>;

  constructor(
    readonly archive: PublicationArchive,
    readonly publication: Publication,
    readonly compatibilityProfile: CompatibilityProfile,
    options: ResourceResolverOptions = {},
    private readonly encryptionByPath: ReadonlyMap<
      PublicationPath,
      EncryptedResourceInfo
    > = new Map(),
  ) {
    this.options = {
      remotePolicy: options.remotePolicy ?? 'block',
      unmanifestedPolicy: options.unmanifestedPolicy ?? 'warn',
      maxResourceBytes: options.maxResourceBytes ?? DEFAULT_MAX_RESOURCE_BYTES,
    };
    this.manifestByPath = new Map(
      publication.manifest
        .filter(
          (item): item is ManifestItem & { path: PublicationPath } =>
            !item.remote && item.path !== undefined,
        )
        .map((item) => [item.path, item]),
    );
    this.manifestByHref = new Map(
      publication.manifest.map((item) => [item.href, item]),
    );
  }

  static async create(
    archive: PublicationArchive,
    publication: Publication,
    compatibilityProfile: CompatibilityProfile,
    options: ResourceResolverOptions = {},
  ): Promise<ResourceResolverCreateResult> {
    const encryption = await loadContainerEncryption(archive);
    return {
      resolver: new ResourceResolver(
        archive,
        publication,
        compatibilityProfile,
        options,
        encryption.resources,
      ),
      diagnostics: encryption.diagnostics,
    };
  }

  resolve(basePath: PublicationPath, source: string): ResourceResolveResult {
    const diagnostics: PublicationDiagnostic[] = [];
    let ref;
    try {
      ref = resolvePublicationReference(basePath, source);
    } catch (cause) {
      diagnostics.push({
        code: 'RESOURCE_REFERENCE_INVALID',
        severity: 'error',
        phase: 'resource',
        message: `Resource reference could not be resolved: ${source}.`,
        path: basePath,
        cause,
      });
      return { request: null, diagnostics };
    }

    if (ref.remote) {
      const scheme = safeScheme(ref.href);
      const manifestItem = this.manifestByHref.get(ref.href);
      const request: ResolvedResourceRequest = {
        source,
        basePath,
        href: ref.href,
        query: ref.query,
        fragment: ref.fragment,
        remote: true,
        manifestItem,
        mediaType:
          manifestItem?.mediaType ??
          (scheme === 'data:' ? mediaTypeFromDataUrl(ref.href) : undefined),
      };

      if (scheme === 'file:') {
        diagnostics.push({
          code: 'RESOURCE_FILE_URL_FORBIDDEN',
          severity: 'error',
          phase: 'resource',
          message: `file: URLs are forbidden in EPUB publications: ${ref.href}.`,
          path: basePath,
        });
        return { request: null, diagnostics };
      }
      if (
        scheme === 'javascript:' ||
        scheme === 'vbscript:' ||
        scheme === 'blob:'
      ) {
        diagnostics.push({
          code: 'RESOURCE_SCHEME_FORBIDDEN',
          severity: 'error',
          phase: 'resource',
          message: `Resource URL uses a forbidden/non-portable scheme ${scheme}: ${ref.href}.`,
          path: basePath,
        });
        return { request: null, diagnostics };
      }
      if (scheme === 'data:') return { request, diagnostics };

      if (scheme !== 'http:' && scheme !== 'https:') {
        diagnostics.push({
          code: 'RESOURCE_SCHEME_UNSUPPORTED',
          severity: 'warning',
          phase: 'resource',
          message: `Resource URL scheme ${scheme || '(unknown)'} is not materialized by this reading system core: ${ref.href}.`,
          path: basePath,
        });
        return { request: null, diagnostics };
      }

      if (this.options.remotePolicy === 'block') {
        diagnostics.push({
          code: 'RESOURCE_REMOTE_BLOCKED',
          severity: 'warning',
          phase: 'resource',
          message: `Remote publication resource is blocked by policy: ${ref.href}.`,
          path: basePath,
        });
      }
      return { request, diagnostics };
    }

    const path = ref.path!;
    const manifestItem = this.manifestByPath.get(path);
    if (!manifestItem) {
      const severity =
        this.options.unmanifestedPolicy === 'block' ? 'error' : 'warning';
      diagnostics.push({
        code: 'RESOURCE_NOT_IN_MANIFEST',
        severity,
        phase: 'resource',
        message: `Container resource is referenced but not declared in the package manifest: ${path}.`,
        path,
      });
      if (this.options.unmanifestedPolicy === 'block')
        return { request: null, diagnostics };
    }

    if (!this.archive.has(path)) {
      diagnostics.push({
        code: 'RESOURCE_ARCHIVE_ENTRY_MISSING',
        severity: 'error',
        phase: 'resource',
        message: `Referenced publication resource is missing from the EPUB container: ${path}.`,
        path,
      });
    }

    const mediaType =
      manifestItem?.mediaType ??
      inferMediaType(path) ??
      'application/octet-stream';
    const request: ResolvedResourceRequest = {
      source,
      basePath,
      href: ref.href,
      path,
      query: ref.query,
      fragment: ref.fragment,
      remote: false,
      manifestItem,
      mediaType,
    };
    return { request, diagnostics };
  }

  async read(
    basePath: PublicationPath,
    source: string,
  ): Promise<ResourceReadResult> {
    const resolved = this.resolve(basePath, source);
    if (!resolved.request || resolved.request.remote) {
      return { resource: null, diagnostics: resolved.diagnostics };
    }
    const read = await this.readRequest(resolved.request);
    return {
      resource: read.resource,
      diagnostics: [...resolved.diagnostics, ...read.diagnostics],
    };
  }

  async readRequest(
    request: ResolvedResourceRequest,
  ): Promise<ResourceReadResult> {
    const diagnostics: PublicationDiagnostic[] = [];
    if (request.remote || !request.path) {
      diagnostics.push({
        code: 'RESOURCE_REMOTE_READ_UNAVAILABLE',
        severity: 'error',
        phase: 'resource',
        message: `ResourceResolver does not perform network fetches: ${request.href}.`,
        path: request.basePath,
      });
      return { resource: null, diagnostics };
    }

    if (!this.archive.has(request.path)) {
      diagnostics.push({
        code: 'RESOURCE_ARCHIVE_ENTRY_MISSING',
        severity: 'error',
        phase: 'resource',
        message: `Publication resource is missing from the EPUB container: ${request.path}.`,
        path: request.path,
      });
      return { resource: null, diagnostics };
    }

    try {
      let bytes = await this.archive.read(request.path);
      if (bytes.byteLength > this.options.maxResourceBytes) {
        diagnostics.push({
          code: 'RESOURCE_SIZE_LIMIT_EXCEEDED',
          severity: 'error',
          phase: 'resource',
          message: `Resource ${request.path} is ${bytes.byteLength} bytes, exceeding the configured ${this.options.maxResourceBytes} byte limit.`,
          path: request.path,
        });
        return { resource: null, diagnostics };
      }
      const encryption = this.encryptionByPath.get(request.path);
      if (encryption) {
        const compatible = await runBinaryResourceCompatibility(
          this.compatibilityProfile.resourceRules,
          {
            publication: this.publication,
            path: request.path,
            mediaType:
              request.mediaType ??
              inferMediaType(request.path) ??
              'application/octet-stream',
            encryptionAlgorithm: encryption.algorithm,
            maxOutputBytes: this.options.maxResourceBytes,
          },
          bytes,
        );
        diagnostics.push(...compatible.diagnostics);
        if (compatible.matchedModuleIds.length === 0) {
          const idpfDisabled = encryption.algorithm === IDPF_FONT_OBFUSCATION;
          diagnostics.push({
            code: idpfDisabled
              ? 'RESOURCE_FONT_DEOBFUSCATION_DISABLED'
              : 'RESOURCE_ENCRYPTION_UNSUPPORTED',
            severity: idpfDisabled ? 'warning' : 'error',
            phase: idpfDisabled ? 'compatibility' : 'resource',
            message: idpfDisabled
              ? `IDPF font recovery is disabled for ${request.path}.`
              : `Resource ${request.path} uses an encryption algorithm without an enabled compatibility module: ${encryption.algorithm}.`,
            path: request.path,
          });
          return { resource: null, diagnostics };
        }
        if (compatible.appliedModuleIds.length === 0) {
          diagnostics.push({
            code:
              encryption.algorithm === IDPF_FONT_OBFUSCATION
                ? 'RESOURCE_FONT_DEOBFUSCATION_FAILED'
                : 'RESOURCE_COMPATIBILITY_TRANSFORM_FAILED',
            severity: 'error',
            phase: 'resource',
            message: `Enabled compatibility modules could not transform encrypted resource ${request.path}.`,
            path: request.path,
          });
          return { resource: null, diagnostics };
        }
        bytes = compatible.value;
      }
      if (bytes.byteLength > this.options.maxResourceBytes) {
        diagnostics.push({
          code: 'RESOURCE_SIZE_LIMIT_EXCEEDED',
          severity: 'error',
          phase: 'resource',
          message: `Resource ${request.path} is ${bytes.byteLength} bytes, exceeding the configured ${this.options.maxResourceBytes} byte limit.`,
          path: request.path,
        });
        return { resource: null, diagnostics };
      }

      const resource: LocalPublicationResource = {
        ...request,
        remote: false,
        path: request.path,
        mediaType:
          request.mediaType ??
          inferMediaType(request.path) ??
          'application/octet-stream',
        bytes,
      };
      return { resource, diagnostics };
    } catch (cause) {
      diagnostics.push({
        code: 'RESOURCE_READ_FAILED',
        severity: 'error',
        phase: 'resource',
        message: `Failed to read publication resource: ${request.path}.`,
        path: request.path,
        cause,
      });
      return { resource: null, diagnostics };
    }
  }
}

function safeScheme(href: string): string {
  try {
    return new URL(href).protocol.toLowerCase();
  } catch {
    return '';
  }
}

function mediaTypeFromDataUrl(href: string): string | undefined {
  const match = /^data:([^;,]+)?(?:;[^,]*)?,/i.exec(href);
  return match?.[1]?.toLowerCase() ?? 'text/plain';
}

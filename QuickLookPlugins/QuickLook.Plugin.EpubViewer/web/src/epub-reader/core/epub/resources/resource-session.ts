import type {
  PublicationDiagnostic,
  PublicationPath,
} from '../publication/model';
import {
  runInlineStyleResourceCompatibility,
  runStylesheetResourceCompatibility,
} from '../compatibility/resource-runner';
import { rewriteCssReferences } from './css-rewriter';
import { decodePublicationText } from './text-decoder';
import { isCssMediaType } from './mime';
import type { MaterializeResult, ObjectUrlFactory } from './model';
import { ObjectUrlStore } from './object-url-store';
import { ResourceResolver } from './resource-resolver';

/**
 * Per-open-publication URL materialization session.
 *
 * Local ZIP resources become object URLs. Stylesheets are recursively rewritten
 * so their relative url()/@import references remain valid after moving to a
 * blob URL. The session owns and revokes every generated URL on dispose().
 */
export class PublicationResourceSession {
  private readonly urls: ObjectUrlStore;
  private readonly cssCache = new Map<string, CssCacheEntry>();
  private disposed = false;

  constructor(
    readonly resolver: ResourceResolver,
    objectUrlFactory: ObjectUrlFactory,
  ) {
    this.urls = new ObjectUrlStore(objectUrlFactory);
  }

  async materialize(
    basePath: PublicationPath,
    source: string,
  ): Promise<MaterializeResult> {
    this.assertAlive();
    if (isInlineDataUrl(source)) {
      return {
        resource: {
          request: { source, basePath, href: source.trim(), remote: true },
          url: source.trim(),
        },
        diagnostics: [],
      };
    }

    const resolved = this.resolver.resolve(basePath, source);
    const diagnostics: PublicationDiagnostic[] = [...resolved.diagnostics];
    const request = resolved.request;
    if (!request) return { resource: null, diagnostics };

    if (request.remote) {
      return {
        resource: {
          request,
          url:
            this.resolver.options.remotePolicy === 'preserve'
              ? request.href
              : null,
        },
        diagnostics,
      };
    }

    if (!request.path) return { resource: { request, url: null }, diagnostics };

    let url: string | null;
    if (isCssMediaType(request.mediaType ?? '')) {
      const materialized = await this.materializeCss(request.path, []);
      diagnostics.push(...materialized.diagnostics);
      url = materialized.url;
    } else {
      const read = await this.resolver.readRequest(request);
      diagnostics.push(...read.diagnostics);
      if (!read.resource) url = null;
      else
        url = this.urls.getOrCreate(
          `raw:${request.path}`,
          read.resource.bytes,
          read.resource.mediaType,
        );
    }

    if (url && request.fragment) url += `#${encodeFragment(request.fragment)}`;
    if (url && request.query) {
      diagnostics.push({
        code: 'RESOURCE_LOCAL_QUERY_DROPPED',
        severity: 'info',
        phase: 'resource',
        message: `Local resource query ${request.query} is used only for authored URL identity and is not appended to the generated object URL.`,
        path: request.path,
      });
    }

    return { resource: { request, url }, diagnostics };
  }

  /**
   * Rewrite CSS authored inline in an XHTML/SVG document. Relative URLs are
   * resolved against the content document that owns the style block/attribute.
   */
  async rewriteInlineCss(
    basePath: PublicationPath,
    cssText: string,
  ): Promise<{
    readonly css: string;
    readonly diagnostics: readonly PublicationDiagnostic[];
  }> {
    this.assertAlive();
    const diagnostics: PublicationDiagnostic[] = [];
    const rewritten = await rewriteCssReferences(
      cssText,
      async (source, kind) => {
        if (source.trim().startsWith('#') || isInlineDataUrl(source))
          return source;

        const child = this.resolver.resolve(basePath, source);
        diagnostics.push(...child.diagnostics);
        const request = child.request;
        if (!request) return 'about:blank';

        if (request.remote) {
          return this.resolver.options.remotePolicy === 'preserve'
            ? request.href
            : 'about:blank';
        }

        if (!request.path) return 'about:blank';
        if (kind === 'import' || isCssMediaType(request.mediaType ?? '')) {
          const nested = await this.materializeCss(request.path, []);
          diagnostics.push(...nested.diagnostics);
          return nested.url ?? 'about:blank';
        }

        const read = await this.resolver.readRequest(request);
        diagnostics.push(...read.diagnostics);
        if (!read.resource) return 'about:blank';
        let url = this.urls.getOrCreate(
          `raw:${request.path}`,
          read.resource.bytes,
          read.resource.mediaType,
        );
        if (request.fragment) url += `#${encodeFragment(request.fragment)}`;
        return url;
      },
    );

    const compatible = await runInlineStyleResourceCompatibility(
      this.resolver.compatibilityProfile.resourceRules,
      {
        publication: this.resolver.publication,
        documentPath: basePath,
        maxOutputCharacters: this.resolver.options.maxResourceBytes,
      },
      rewritten.css,
    );
    diagnostics.push(...compatible.diagnostics);
    return { css: compatible.value, diagnostics };
  }

  /**
   * Create a session-owned object URL for generated renderer content. The URL
   * participates in the same deterministic publication-session cleanup as raw
   * and rewritten resources.
   */
  createGeneratedResourceUrl(
    key: string,
    bytes: Uint8Array,
    mediaType: string,
  ): string {
    this.assertAlive();
    return this.urls.getOrCreate(`generated:${key}`, bytes, mediaType);
  }

  createGeneratedTextUrl(
    key: string,
    text: string,
    mediaType = 'application/xhtml+xml;charset=utf-8',
  ): string {
    return this.createGeneratedResourceUrl(
      key,
      new TextEncoder().encode(text),
      mediaType,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cssCache.clear();
    this.urls.dispose();
  }

  get objectUrlCount(): number {
    return this.urls.size;
  }

  private async materializeCss(
    path: PublicationPath,
    stack: readonly PublicationPath[],
  ): Promise<CssMaterialization> {
    if (stack.includes(path)) {
      return {
        url: null,
        diagnostics: [
          {
            code: 'RESOURCE_CSS_IMPORT_CYCLE',
            severity: 'warning',
            phase: 'resource',
            message: `CSS @import cycle detected: ${[...stack, path].join(' -> ')}.`,
            path,
          },
        ],
      };
    }

    const cacheKey = `${this.resolver.compatibilityProfile.signature}:${path}`;
    const cached = this.cssCache.get(cacheKey);
    // Only top-level requests share work that is still in flight. Awaiting an
    // unrelated recursive chain here can make two concurrent import graphs wait
    // on each other forever (A -> B while B -> A). Settled results remain safe
    // to reuse from every depth.
    if (cached && (stack.length === 0 || cached.settled)) return cached.promise;

    const promise = this.buildCss(path, [...stack, path]);
    let ownedEntry: CssCacheEntry | null = null;
    if (stack.length === 0 && !cached) {
      ownedEntry = { promise, settled: false };
      this.cssCache.set(cacheKey, ownedEntry);
    }
    try {
      const result = await promise;
      if (ownedEntry) ownedEntry.settled = true;
      else if (!this.disposed && !this.cssCache.has(cacheKey)) {
        this.cssCache.set(cacheKey, {
          promise: Promise.resolve(result),
          settled: true,
        });
      }
      return result;
    } catch (error) {
      if (ownedEntry && this.cssCache.get(cacheKey) === ownedEntry)
        this.cssCache.delete(cacheKey);
      throw error;
    }
  }

  private async buildCss(
    path: PublicationPath,
    stack: readonly PublicationPath[],
  ): Promise<CssMaterialization> {
    const diagnostics: PublicationDiagnostic[] = [];
    const resolved = this.resolver.resolve('', path);
    diagnostics.push(...resolved.diagnostics);
    const request = resolved.request;
    if (!request || request.remote) return { url: null, diagnostics };

    const read = await this.resolver.readRequest(request);
    diagnostics.push(...read.diagnostics);
    if (!read.resource) return { url: null, diagnostics };

    const cssText = decodePublicationText(
      read.resource.bytes,
      read.resource.mediaType,
    );
    const rewritten = await rewriteCssReferences(
      cssText,
      async (source, kind) => {
        // Fragment-only CSS URLs commonly target paint servers or masks in the
        // rendered document. Rebinding them to the stylesheet Blob would be wrong.
        if (source.trim().startsWith('#') || isInlineDataUrl(source))
          return source;

        const child = this.resolver.resolve(path, source);
        diagnostics.push(...child.diagnostics);
        const childRequest = child.request;
        if (!childRequest) return 'about:blank';

        if (childRequest.remote) {
          return this.resolver.options.remotePolicy === 'preserve'
            ? childRequest.href
            : 'about:blank';
        }

        if (!childRequest.path) return 'about:blank';
        if (kind === 'import' || isCssMediaType(childRequest.mediaType ?? '')) {
          const nested = await this.materializeCss(childRequest.path, stack);
          diagnostics.push(...nested.diagnostics);
          return nested.url ?? 'about:blank';
        }

        const childRead = await this.resolver.readRequest(childRequest);
        diagnostics.push(...childRead.diagnostics);
        if (!childRead.resource) return 'about:blank';
        let url = this.urls.getOrCreate(
          `raw:${childRequest.path}`,
          childRead.resource.bytes,
          childRead.resource.mediaType,
        );
        if (childRequest.fragment)
          url += `#${encodeFragment(childRequest.fragment)}`;
        return url;
      },
    );

    const compatible = await runStylesheetResourceCompatibility(
      this.resolver.compatibilityProfile.resourceRules,
      {
        publication: this.resolver.publication,
        path,
        maxOutputCharacters: this.resolver.options.maxResourceBytes,
      },
      rewritten.css,
    );
    diagnostics.push(...compatible.diagnostics);
    const bytes = new TextEncoder().encode(compatible.value);
    const url = this.urls.getOrCreate(
      `css:${this.resolver.compatibilityProfile.signature}:${path}`,
      bytes,
      'text/css;charset=utf-8',
    );
    return { url, diagnostics };
  }

  private assertAlive(): void {
    if (this.disposed)
      throw new Error('PublicationResourceSession has been disposed.');
  }
}

interface CssMaterialization {
  readonly url: string | null;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

interface CssCacheEntry {
  readonly promise: Promise<CssMaterialization>;
  settled: boolean;
}

function encodeFragment(fragment: string): string {
  return (
    encodeURIComponent(fragment)
      // Keep common URI-fragment punctuation readable and interoperable.
      .replace(/%2F/gi, '/')
      .replace(/%3A/gi, ':')
  );
}

function isInlineDataUrl(source: string): boolean {
  return /^data:/i.test(source.trim());
}

import type {
  PublicationDiagnostic,
  PublicationPath,
  SpineItem,
} from '../publication';
import { resolvePublicationDocumentReference } from '../publication';
import { PublicationResourceSession, rewriteCssReferences } from '../resources';
import type { ContentDocumentParseMode } from '../compatibility';
import type {
  BrowserXmlPlatform,
  MaterializedContentDocument,
  ParsedContentDocument,
  XhtmlMaterializerOptions,
} from './model';
import { neutralizeDocumentBases } from './xhtml-materializer/document-base';
import { annotateNavigationLinks } from './xhtml-materializer/navigation-links';
import { inspectStaticPresentationHints } from './xhtml-materializer/presentation-hints';
import { referenceHrefWithFragment } from './xhtml-materializer/reference';
import {
  disableAutomaticDocumentNavigation,
  disableScripts,
  forceDeterministicImageLoading,
} from './xhtml-materializer/security';
import {
  formatSrcsetCandidate,
  parseSrcset,
} from './xhtml-materializer/srcset';

export { parseSrcset } from './xhtml-materializer/srcset';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';

/**
 * Builds a self-contained browser-loadable XHTML document from a spine item.
 * Publication-relative resources are rebound to object URLs owned by the open
 * PublicationResourceSession; navigation links are annotated, not followed.
 */
export async function materializeParsedXhtmlSpineItem(
  item: SpineItem,
  session: PublicationResourceSession,
  platform: BrowserXmlPlatform,
  parsedContent: ParsedContentDocument,
  options: XhtmlMaterializerOptions = {},
): Promise<MaterializedContentDocument> {
  if (item.remote || !item.path) {
    throw new Error(
      `XHTML materializer requires a container-local spine item: ${item.href}.`,
    );
  }
  if (!isXhtmlMediaType(item.mediaType)) {
    throw new Error(
      `XHTML materializer cannot render media type ${item.mediaType}.`,
    );
  }

  const diagnostics: PublicationDiagnostic[] = [...parsedContent.diagnostics];
  const document = parsedContent.document;

  if (options.disableScripts ?? true) {
    disableScripts(document, diagnostics, item.path);
  }
  disableAutomaticDocumentNavigation(document, diagnostics, item.path);

  const { documentBaseHref: baseHref, elementBaseHrefs } =
    neutralizeDocumentBases(document, item.path, diagnostics);
  forceDeterministicImageLoading(document);
  await rewriteDocumentResources(
    document,
    item.path,
    baseHref,
    elementBaseHrefs,
    session,
    diagnostics,
  );
  if (options.annotateLinks ?? true) {
    annotateNavigationLinks(
      document,
      item.path,
      baseHref,
      elementBaseHrefs,
      diagnostics,
    );
  }

  const hints = inspectStaticPresentationHints(document);
  const serialized = ensureXmlDeclaration(platform.serializeXml(document));
  const url = session.createGeneratedTextUrl(
    `xhtml:${item.path}`,
    serialized,
    'application/xhtml+xml;charset=utf-8',
  );

  return {
    sourcePath: item.path,
    markup: serialized,
    url,
    mediaType: 'application/xhtml+xml',
    hints,
    diagnostics,
  };
}

export function parseXhtmlContentDocument(
  source: string,
  path: PublicationPath,
  platform: BrowserXmlPlatform,
  parseMode: ContentDocumentParseMode = 'xml',
): {
  readonly document: Document;
  readonly diagnostics: readonly PublicationDiagnostic[];
} {
  const mediaType =
    parseMode === 'html-recovery' ? 'text/html' : 'application/xhtml+xml';
  const document = platform.parseXml(source, mediaType);
  assertParsedXhtml(document, path);
  return { document, diagnostics: [] };
}

async function rewriteDocumentResources(
  document: Document,
  basePath: PublicationPath,
  baseHref: string | undefined,
  xmlBases: ReadonlyMap<Element, string | undefined>,
  session: PublicationResourceSession,
  diagnostics: PublicationDiagnostic[],
): Promise<void> {
  const elements = Array.from(document.getElementsByTagName('*'));

  for (const element of elements) {
    const namespace = element.namespaceURI;
    const local = element.localName.toLowerCase();
    const elementBaseHref = xmlBases.get(element) ?? baseHref;

    if (
      namespace === XHTML_NS &&
      local === 'link' &&
      hasRelToken(element, 'stylesheet')
    ) {
      await rewriteUrlAttribute(
        element,
        'href',
        basePath,
        elementBaseHref,
        session,
        diagnostics,
      );
      continue;
    }

    if ((namespace === XHTML_NS || namespace === SVG_NS) && local === 'style') {
      const css = await rewriteDocumentInlineCss(
        basePath,
        elementBaseHref,
        element.textContent ?? '',
        session,
      );
      diagnostics.push(...css.diagnostics);
      element.textContent = css.css;
      continue;
    }

    if (element.hasAttribute('style')) {
      const css = await rewriteDocumentInlineCss(
        basePath,
        elementBaseHref,
        element.getAttribute('style') ?? '',
        session,
      );
      diagnostics.push(...css.diagnostics);
      element.setAttribute('style', css.css);
    }

    if (namespace === XHTML_NS) {
      if (
        [
          'img',
          'audio',
          'video',
          'source',
          'track',
          'input',
          'embed',
          'iframe',
        ].includes(local)
      ) {
        await rewriteUrlAttribute(
          element,
          'src',
          basePath,
          elementBaseHref,
          session,
          diagnostics,
        );
      }
      if (local === 'video') {
        await rewriteUrlAttribute(
          element,
          'poster',
          basePath,
          elementBaseHref,
          session,
          diagnostics,
        );
      }
      if (local === 'object') {
        await rewriteUrlAttribute(
          element,
          'data',
          basePath,
          elementBaseHref,
          session,
          diagnostics,
        );
      }
      if (local === 'img' || local === 'source') {
        await rewriteSrcsetAttribute(
          element,
          basePath,
          elementBaseHref,
          session,
          diagnostics,
        );
      }
    }

    if (namespace === SVG_NS && ['image', 'use'].includes(local)) {
      await rewriteUrlAttribute(
        element,
        'href',
        basePath,
        elementBaseHref,
        session,
        diagnostics,
      );
      if (element.hasAttributeNS(XLINK_NS, 'href')) {
        await rewriteNamespacedUrlAttribute(
          element,
          XLINK_NS,
          'xlink:href',
          basePath,
          elementBaseHref,
          session,
          diagnostics,
        );
      }
    }
  }
}

async function rewriteUrlAttribute(
  element: Element,
  attribute: string,
  basePath: PublicationPath,
  baseHref: string | undefined,
  session: PublicationResourceSession,
  diagnostics: PublicationDiagnostic[],
): Promise<void> {
  if (!element.hasAttribute(attribute)) return;
  const authored = element.getAttribute(attribute)?.trim() ?? '';
  if (!authored) return;
  if (authored.startsWith('#') && !baseHref) return;

  const result = await materializeDocumentReference(
    basePath,
    baseHref,
    authored,
    session,
  );
  diagnostics.push(...result.diagnostics);
  element.setAttribute(attribute, result.resource?.url ?? 'about:blank');
}

async function rewriteNamespacedUrlAttribute(
  element: Element,
  namespace: string,
  qualifiedName: string,
  basePath: PublicationPath,
  baseHref: string | undefined,
  session: PublicationResourceSession,
  diagnostics: PublicationDiagnostic[],
): Promise<void> {
  const authored = element.getAttributeNS(namespace, 'href')?.trim() ?? '';
  if (!authored) return;
  if (authored.startsWith('#') && !baseHref) return;
  const result = await materializeDocumentReference(
    basePath,
    baseHref,
    authored,
    session,
  );
  diagnostics.push(...result.diagnostics);
  element.setAttributeNS(
    namespace,
    qualifiedName,
    result.resource?.url ?? 'about:blank',
  );
}

async function rewriteSrcsetAttribute(
  element: Element,
  basePath: PublicationPath,
  baseHref: string | undefined,
  session: PublicationResourceSession,
  diagnostics: PublicationDiagnostic[],
): Promise<void> {
  const authored = element.getAttribute('srcset');
  if (!authored) return;

  const candidates = parseSrcset(authored);
  const rewritten: string[] = [];
  for (const candidate of candidates) {
    if (/^data:/i.test(candidate.url)) {
      rewritten.push(formatSrcsetCandidate(candidate));
      continue;
    }
    const result = await materializeDocumentReference(
      basePath,
      baseHref,
      candidate.url,
      session,
    );
    diagnostics.push(...result.diagnostics);
    rewritten.push(
      formatSrcsetCandidate({
        url: result.resource?.url ?? 'about:blank',
        descriptor: candidate.descriptor,
      }),
    );
  }
  element.setAttribute('srcset', rewritten.join(', '));
}

async function rewriteDocumentInlineCss(
  basePath: PublicationPath,
  baseHref: string | undefined,
  cssText: string,
  session: PublicationResourceSession,
): Promise<{
  readonly css: string;
  readonly diagnostics: readonly PublicationDiagnostic[];
}> {
  const diagnostics: PublicationDiagnostic[] = [];
  const rewritten = await rewriteCssReferences(cssText, async (source) => {
    const trimmed = source.trim();
    if (/^data:/i.test(trimmed)) return source;
    if (trimmed.startsWith('#') && !baseHref) return source;

    try {
      const result = await materializeDocumentReference(
        basePath,
        baseHref,
        source,
        session,
      );
      diagnostics.push(...result.diagnostics);
      return result.resource?.url ?? 'about:blank';
    } catch (cause) {
      diagnostics.push({
        code: 'CONTENT_CSS_REFERENCE_INVALID',
        severity: 'warning',
        phase: 'content',
        message: `Inline CSS reference could not be resolved: ${source}.`,
        path: basePath,
        cause,
      });
      return 'about:blank';
    }
  });
  return { css: rewritten.css, diagnostics };
}

async function materializeDocumentReference(
  basePath: PublicationPath,
  baseHref: string | undefined,
  source: string,
  session: PublicationResourceSession,
) {
  const resolved = resolvePublicationDocumentReference(
    basePath,
    baseHref,
    source,
  );
  return session.materialize('', referenceHrefWithFragment(resolved));
}

function assertParsedXhtml(document: Document, path: PublicationPath): void {
  const root = document.documentElement;
  if (!root)
    throw new Error(`XHTML content document has no root element: ${path}.`);

  const parserErrors = Array.from(document.getElementsByTagName('parsererror'));
  if (parserErrors.length > 0) {
    throw new Error(`XHTML content document is not well-formed XML: ${path}.`);
  }

  if (root.localName.toLowerCase() !== 'html') {
    throw new Error(
      `Expected XHTML html root element in ${path}, found ${root.localName}.`,
    );
  }
}

function hasRelToken(element: Element, token: string): boolean {
  return (element.getAttribute('rel') ?? '')
    .split(/\s+/)
    .some((value) => value.toLowerCase() === token);
}

function ensureXmlDeclaration(source: string): string {
  return /^\s*<\?xml\b/i.test(source)
    ? source
    : `<?xml version="1.0" encoding="utf-8"?>\n${source}`;
}

function isXhtmlMediaType(mediaType: string): boolean {
  const normalized = mediaType.split(';', 1)[0]?.trim().toLowerCase();
  return normalized === 'application/xhtml+xml' || normalized === 'text/html';
}

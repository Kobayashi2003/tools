import type { PublicationDiagnostic, SpineItem } from '../publication';
import { resolvePublicationReference } from '../publication';
import {
  decodePublicationText,
  PublicationResourceSession,
} from '../resources';
import type { BrowserXmlPlatform, MaterializedContentDocument } from './model';
import { inspectSvgIntrinsicViewport } from './intrinsic-viewport';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XLINK_NS = 'http://www.w3.org/1999/xlink';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export async function materializeSvgSpineItem(
  item: SpineItem,
  session: PublicationResourceSession,
  platform: BrowserXmlPlatform,
): Promise<MaterializedContentDocument> {
  if (item.remote || !item.path) {
    throw new Error(
      `SVG materializer requires a container-local spine item: ${item.href}.`,
    );
  }
  if (!isSvgMediaType(item.mediaType)) {
    throw new Error(
      `SVG materializer cannot render media type ${item.mediaType}.`,
    );
  }

  const diagnostics: PublicationDiagnostic[] = [];
  const read = await session.resolver.read('', item.path);
  diagnostics.push(...read.diagnostics);
  if (!read.resource)
    throw new Error(`Unable to read SVG content document ${item.path}.`);

  const source = decodePublicationText(
    read.resource.bytes,
    read.resource.mediaType,
  );
  const document = platform.parseXml(source, 'image/svg+xml');
  assertParsedSvg(document, item.path);

  const scripts = Array.from(document.getElementsByTagNameNS(SVG_NS, 'script'));
  for (const script of scripts) script.remove();
  if (scripts.length > 0) {
    diagnostics.push({
      code: 'CONTENT_SCRIPTING_DISABLED',
      severity: 'info',
      phase: 'content',
      path: item.path,
      message: `Disabled authored SVG scripts in ${item.path}.`,
    });
  }

  const xmlBaseCount = Array.from(document.getElementsByTagName('*')).filter(
    (element) => element.hasAttributeNS(XML_NS, 'base'),
  ).length;
  if (xmlBaseCount > 0) {
    diagnostics.push({
      code: 'CONTENT_XML_BASE_UNSUPPORTED',
      severity: 'warning',
      phase: 'content',
      path: item.path,
      message: `Found ${xmlBaseCount} xml:base declaration(s) in ${item.path}; nested xml:base semantics are not applied yet.`,
    });
  }

  for (const element of Array.from(document.getElementsByTagName('*'))) {
    if (element.hasAttribute('style')) {
      const rewritten = await session.rewriteInlineCss(
        item.path,
        element.getAttribute('style') ?? '',
      );
      diagnostics.push(...rewritten.diagnostics);
      element.setAttribute('style', rewritten.css);
    }
    if (element.namespaceURI === SVG_NS && element.localName === 'style') {
      const rewritten = await session.rewriteInlineCss(
        item.path,
        element.textContent ?? '',
      );
      diagnostics.push(...rewritten.diagnostics);
      element.textContent = rewritten.css;
    }

    if (element.namespaceURI !== SVG_NS) continue;
    if (['image', 'use'].includes(element.localName)) {
      await rewriteHref(element, item, session, diagnostics, null);
      if (element.hasAttributeNS(XLINK_NS, 'href')) {
        await rewriteHref(element, item, session, diagnostics, XLINK_NS);
      }
    }

    if (element.localName === 'a') {
      const href = (
        element.getAttribute('href') ?? element.getAttributeNS(XLINK_NS, 'href')
      )?.trim();
      if (href && !href.startsWith('#')) {
        try {
          element.setAttribute(
            'data-epub-href',
            resolveSvgNavigationHref(item.path, href),
          );
        } catch (cause) {
          diagnostics.push({
            code: 'CONTENT_LINK_REFERENCE_INVALID',
            severity: 'warning',
            phase: 'content',
            message: `Hyperlink could not be resolved: ${href}.`,
            path: item.path,
            cause,
          });
        }
        element.removeAttribute('href');
        element.removeAttributeNS(XLINK_NS, 'href');
      }
      element.removeAttribute('target');
    }
  }

  const hints = {
    viewport: inspectSvgIntrinsicViewport(document) ?? undefined,
  };
  const serialized = ensureXmlDeclaration(platform.serializeXml(document));
  const url = session.createGeneratedTextUrl(
    `svg:${item.path}`,
    serialized,
    'image/svg+xml;charset=utf-8',
  );
  return {
    sourcePath: item.path,
    markup: serialized,
    url,
    mediaType: 'image/svg+xml',
    hints,
    diagnostics,
  };
}

export function resolveSvgNavigationHref(
  documentPath: string,
  authoredHref: string,
): string {
  return resolvePublicationReference(documentPath, authoredHref).href;
}

async function rewriteHref(
  element: Element,
  item: SpineItem & { path?: string },
  session: PublicationResourceSession,
  diagnostics: PublicationDiagnostic[],
  namespace: string | null,
): Promise<void> {
  const authored = namespace
    ? element.getAttributeNS(namespace, 'href')
    : element.getAttribute('href');
  if (!authored || authored.trim().startsWith('#') || !item.path) return;
  const result = await session.materialize(item.path, authored);
  diagnostics.push(...result.diagnostics);
  const url = result.resource?.url ?? 'about:blank';
  if (namespace) element.setAttributeNS(namespace, 'xlink:href', url);
  else element.setAttribute('href', url);
}

function assertParsedSvg(document: Document, path: string): void {
  const root = document.documentElement;
  if (!root || root.namespaceURI !== SVG_NS || root.localName !== 'svg') {
    throw new Error(`Expected SVG root element in ${path}.`);
  }
  if (document.getElementsByTagName('parsererror').length > 0) {
    throw new Error(`SVG content document is not well-formed XML: ${path}.`);
  }
}

function ensureXmlDeclaration(source: string): string {
  return /^\s*<\?xml\b/i.test(source)
    ? source
    : `<?xml version="1.0" encoding="utf-8"?>\n${source}`;
}

function isSvgMediaType(mediaType: string): boolean {
  return mediaType.split(';', 1)[0]?.trim().toLowerCase() === 'image/svg+xml';
}

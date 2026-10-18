import {
  resolvePublicationDocumentReference,
  type PublicationDiagnostic,
  type PublicationPath,
} from '../../publication';
import { referenceHrefWithFragment } from './reference';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

export function annotateNavigationLinks(
  document: Document,
  basePath: PublicationPath,
  baseHref: string | undefined,
  elementBaseHrefs: ReadonlyMap<Element, string | undefined>,
  diagnostics: PublicationDiagnostic[],
): void {
  for (const anchor of Array.from(
    document.getElementsByTagNameNS(XHTML_NS, 'a'),
  )) {
    const href = anchor.getAttribute('href')?.trim();
    if (!href) continue;

    neutralizeTarget(anchor);
    try {
      const effectiveBaseHref = elementBaseHrefs.get(anchor) ?? baseHref;
      const resolved = resolvePublicationDocumentReference(
        basePath,
        effectiveBaseHref,
        href,
      );
      anchor.setAttribute(
        'data-epub-href',
        referenceHrefWithFragment(resolved),
      );

      if (!resolved.remote && resolved.path === basePath && resolved.fragment) {
        anchor.setAttribute(
          'href',
          `#${encodeURIComponent(resolved.fragment)}`,
        );
      } else if (href.startsWith('#')) {
        // A document base can turn a fragment-only URL into a cross-resource
        // target; prevent the generated Blob URL from reinterpreting it.
        anchor.setAttribute('href', 'about:blank');
      }
    } catch (cause) {
      // An invalid authored URL must not remain live in the generated Blob
      // document, where the browser could resolve it outside our policy layer.
      anchor.removeAttribute('href');
      anchor.removeAttribute('data-epub-href');
      diagnostics.push({
        code: 'CONTENT_LINK_REFERENCE_INVALID',
        severity: 'warning',
        phase: 'content',
        message: `Hyperlink could not be resolved: ${href}.`,
        path: basePath,
        cause,
      });
    }
  }
}

function neutralizeTarget(anchor: Element): void {
  const target = anchor.getAttribute('target');
  if (!target) return;
  anchor.setAttribute('data-epub-authored-target', target);
  anchor.removeAttribute('target');
}

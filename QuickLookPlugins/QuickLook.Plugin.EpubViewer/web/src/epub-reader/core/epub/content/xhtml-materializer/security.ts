import type { PublicationDiagnostic, PublicationPath } from '../../publication';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const SVG_NS = 'http://www.w3.org/2000/svg';

export function disableScripts(
  document: Document,
  diagnostics: PublicationDiagnostic[],
  path: PublicationPath,
): void {
  const scripts = [
    ...Array.from(document.getElementsByTagNameNS(XHTML_NS, 'script')),
    ...Array.from(document.getElementsByTagNameNS(SVG_NS, 'script')),
  ];
  if (scripts.length === 0) return;

  // Removal prevents execution as well as external script fetches.
  for (const script of scripts) script.remove();
  diagnostics.push({
    code: 'CONTENT_SCRIPTING_DISABLED',
    severity: 'info',
    phase: 'content',
    message: `Disabled ${scripts.length} authored script element(s) in ${path}.`,
    path,
  });
}

export function disableAutomaticDocumentNavigation(
  document: Document,
  diagnostics: PublicationDiagnostic[],
  path: PublicationPath,
): void {
  const refreshElements = Array.from(
    document.getElementsByTagNameNS(XHTML_NS, 'meta'),
  ).filter(
    (meta) =>
      (meta.getAttribute('http-equiv') ?? '').trim().toLowerCase() ===
      'refresh',
  );

  for (const meta of refreshElements) {
    meta.setAttribute('data-epub-disabled-http-equiv', 'refresh');
    meta.removeAttribute('http-equiv');
    meta.removeAttribute('content');
  }
  for (const anchor of Array.from(
    document.getElementsByTagNameNS(XHTML_NS, 'a'),
  )) {
    // Ping is a side-effecting request unrelated to routed reader navigation.
    anchor.removeAttribute('ping');
  }

  if (refreshElements.length === 0) return;
  diagnostics.push({
    code: 'CONTENT_AUTOMATIC_NAVIGATION_DISABLED',
    severity: 'info',
    phase: 'content',
    message: `Disabled ${refreshElements.length} meta refresh navigation directive(s) in ${path}.`,
    path,
  });
}

export function forceDeterministicImageLoading(document: Document): void {
  for (const image of Array.from(
    document.getElementsByTagNameNS(XHTML_NS, 'img'),
  )) {
    // Pagination needs intrinsic dimensions for images outside the first view.
    image.setAttribute('loading', 'eager');
  }
}

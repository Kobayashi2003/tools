import type {
  Landmark,
  NavigationModel,
  PageListItem,
  PublicationDiagnostic,
  PublicationPath,
  TocItem,
} from './model';
import { resolvePublicationReference } from './path';
import {
  attr,
  childElements,
  descendants,
  firstChild,
  navigationLabel,
  parseXml,
  tokenList,
  type XmlElementNode,
} from '../xml/xml';

export interface NavigationParseResult {
  readonly navigation: NavigationModel;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export function parseNavigationDocument(
  xml: string,
  navPath: PublicationPath,
): NavigationParseResult {
  const parsed = parseXml(xml, navPath, 'navigation');
  const diagnostics = [...parsed.diagnostics];
  const root = parsed.root;
  const empty: NavigationModel = {
    source: 'epub3-nav',
    sourcePath: navPath,
    toc: [],
    landmarks: [],
    pageList: [],
  };

  if (!root || root.localName !== 'html') {
    diagnostics.push(
      diag(
        'NAV_ROOT_INVALID',
        'error',
        'EPUB Navigation Document does not have an <html> root.',
        navPath,
      ),
    );
    return { navigation: empty, diagnostics };
  }

  const navs = descendants(root, 'nav');
  const findNav = (kind: string) =>
    navs.find((nav) => tokenList(attr(nav, 'epub:type')).includes(kind));
  const tocNav = findNav('toc');
  const pageListNav = findNav('page-list');
  const landmarksNav = findNav('landmarks');

  if (!tocNav)
    diagnostics.push(
      diag(
        'NAV_TOC_MISSING',
        'error',
        'EPUB Navigation Document has no toc nav.',
        navPath,
      ),
    );

  return {
    navigation: {
      source: 'epub3-nav',
      sourcePath: navPath,
      toc: tocNav ? parseTocList(tocNav, navPath, diagnostics) : [],
      pageList: pageListNav
        ? parsePageList(pageListNav, navPath, diagnostics)
        : [],
      landmarks: landmarksNav
        ? parseLandmarks(landmarksNav, navPath, diagnostics)
        : [],
    },
    diagnostics,
  };
}

function parseTocList(
  nav: XmlElementNode,
  navPath: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): TocItem[] {
  const ol = firstChild(nav, 'ol') ?? descendants(nav, 'ol')[0];
  if (!ol) {
    diagnostics.push(
      diag(
        'NAV_TOC_LIST_MISSING',
        'error',
        'toc nav does not contain an ordered list.',
        navPath,
      ),
    );
    return [];
  }
  return parseTocOl(ol, navPath, diagnostics);
}

function parseTocOl(
  ol: XmlElementNode,
  navPath: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): TocItem[] {
  const items: TocItem[] = [];
  for (const li of childElements(ol, 'li')) {
    const marker = childElements(li).find(
      (child) => child.localName === 'a' || child.localName === 'span',
    );
    if (!marker) {
      diagnostics.push(
        diag(
          'NAV_TOC_ITEM_MARKER_MISSING',
          'warning',
          'A toc list item has no leading <a> or <span>.',
          navPath,
        ),
      );
      continue;
    }
    const label = navigationLabel(marker);
    const nested = childElements(li, 'ol')[0];
    const children = nested ? parseTocOl(nested, navPath, diagnostics) : [];
    const id = attr(marker, 'id') ?? attr(li, 'id');

    if (marker.localName === 'span') {
      items.push({ id, label: label || '(untitled)', children });
      continue;
    }

    const sourceHref = attr(marker, 'href');
    if (!sourceHref) {
      diagnostics.push(
        diag(
          'NAV_TOC_HREF_MISSING',
          'warning',
          'A toc link has no href.',
          navPath,
        ),
      );
      items.push({ id, label: label || '(untitled)', children });
      continue;
    }
    try {
      const ref = resolvePublicationReference(navPath, sourceHref);
      if (ref.remote) {
        diagnostics.push(
          diag(
            'NAV_CORE_LINK_REMOTE',
            'error',
            `toc link must resolve to top-level EPUB content: ${sourceHref}.`,
            navPath,
          ),
        );
        items.push({ id, label: label || '(untitled)', children });
        continue;
      }
      items.push({
        id,
        label: label || '(untitled)',
        href: ref.href,
        path: ref.path,
        fragment: ref.fragment,
        children,
      });
    } catch (cause) {
      diagnostics.push({
        ...diag(
          'NAV_TOC_HREF_INVALID',
          'warning',
          `Could not resolve toc href ${sourceHref}.`,
          navPath,
        ),
        cause,
      });
      items.push({ id, label: label || '(untitled)', children });
    }
  }
  return items;
}

function parsePageList(
  nav: XmlElementNode,
  navPath: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): PageListItem[] {
  const ol = firstChild(nav, 'ol') ?? descendants(nav, 'ol')[0];
  if (!ol) return [];
  const out: PageListItem[] = [];
  for (const li of childElements(ol, 'li')) {
    const link = childElements(li, 'a')[0];
    const href = link ? attr(link, 'href') : undefined;
    if (!link || !href) continue;
    try {
      const ref = resolvePublicationReference(navPath, href);
      if (ref.remote) {
        diagnostics.push(
          diag(
            'NAV_PAGE_LIST_REMOTE',
            'error',
            `page-list link must stay in the EPUB: ${href}.`,
            navPath,
          ),
        );
        continue;
      }
      out.push({
        label: navigationLabel(link),
        href: ref.href,
        path: ref.path,
        fragment: ref.fragment,
      });
    } catch (cause) {
      diagnostics.push({
        ...diag(
          'NAV_PAGE_LIST_HREF_INVALID',
          'warning',
          `Could not resolve page-list href ${href}.`,
          navPath,
        ),
        cause,
      });
    }
  }
  return out;
}

function parseLandmarks(
  nav: XmlElementNode,
  navPath: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): Landmark[] {
  const ol = firstChild(nav, 'ol') ?? descendants(nav, 'ol')[0];
  if (!ol) return [];
  const out: Landmark[] = [];
  for (const li of childElements(ol, 'li')) {
    const link = childElements(li, 'a')[0];
    const href = link ? attr(link, 'href') : undefined;
    const types = link ? tokenList(attr(link, 'epub:type')) : [];
    if (!link || !href || types.length === 0) {
      diagnostics.push(
        diag(
          'NAV_LANDMARK_INVALID',
          'warning',
          'A landmarks entry is missing href or epub:type.',
          navPath,
        ),
      );
      continue;
    }
    try {
      const ref = resolvePublicationReference(navPath, href);
      if (ref.remote) {
        diagnostics.push(
          diag(
            'NAV_LANDMARK_REMOTE',
            'error',
            `landmarks link must stay in the EPUB: ${href}.`,
            navPath,
          ),
        );
        continue;
      }
      out.push({
        types,
        label: navigationLabel(link),
        href: ref.href,
        path: ref.path,
        fragment: ref.fragment,
      });
    } catch (cause) {
      diagnostics.push({
        ...diag(
          'NAV_LANDMARK_HREF_INVALID',
          'warning',
          `Could not resolve landmark href ${href}.`,
          navPath,
        ),
        cause,
      });
    }
  }
  return out;
}

function diag(
  code: string,
  severity: PublicationDiagnostic['severity'],
  message: string,
  path: PublicationPath,
): PublicationDiagnostic {
  return { code, severity, phase: 'navigation', message, path };
}

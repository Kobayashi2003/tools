import type {
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
  parseXml,
  textContent,
  type XmlElementNode,
} from '../xml/xml';

export interface NcxParseResult {
  readonly navigation: NavigationModel;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export function parseNcxDocument(
  xml: string,
  ncxPath: PublicationPath,
): NcxParseResult {
  const parsed = parseXml(xml, ncxPath, 'navigation');
  const diagnostics = [...parsed.diagnostics];
  const root = parsed.root;
  const empty: NavigationModel = {
    source: 'ncx',
    sourcePath: ncxPath,
    toc: [],
    landmarks: [],
    pageList: [],
  };

  if (!root || root.localName !== 'ncx') {
    diagnostics.push(
      diag(
        'NCX_ROOT_INVALID',
        'error',
        'NCX document does not have an <ncx> root.',
        ncxPath,
      ),
    );
    return { navigation: empty, diagnostics };
  }

  const navMap = firstChild(root, 'navMap') ?? descendants(root, 'navMap')[0];
  const pageList =
    firstChild(root, 'pageList') ?? descendants(root, 'pageList')[0];
  return {
    navigation: {
      source: 'ncx',
      sourcePath: ncxPath,
      toc: navMap
        ? childElements(navMap, 'navPoint').map((point) =>
            parseNavPoint(point, ncxPath, diagnostics),
          )
        : [],
      landmarks: [],
      pageList: pageList
        ? parseNcxPageList(pageList, ncxPath, diagnostics)
        : [],
    },
    diagnostics,
  };
}

function parseNavPoint(
  point: XmlElementNode,
  ncxPath: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): TocItem {
  const label = ncxLabel(point) || '(untitled)';
  const content = firstChild(point, 'content');
  const src = content ? attr(content, 'src') : undefined;
  const children = childElements(point, 'navPoint').map((child) =>
    parseNavPoint(child, ncxPath, diagnostics),
  );
  const id = attr(point, 'id');
  if (!src) return { id, label, children };

  try {
    const ref = resolvePublicationReference(ncxPath, src);
    return {
      id,
      label,
      href: ref.href,
      path: ref.path,
      fragment: ref.fragment,
      children,
    };
  } catch (cause) {
    diagnostics.push({
      ...diag(
        'NCX_CONTENT_SRC_INVALID',
        'warning',
        `Could not resolve NCX target ${src}.`,
        ncxPath,
      ),
      cause,
    });
    return { id, label, children };
  }
}

function parseNcxPageList(
  pageList: XmlElementNode,
  ncxPath: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): PageListItem[] {
  const out: PageListItem[] = [];
  for (const target of childElements(pageList, 'pageTarget')) {
    const content = firstChild(target, 'content');
    const src = content ? attr(content, 'src') : undefined;
    if (!src) continue;
    try {
      const ref = resolvePublicationReference(ncxPath, src);
      out.push({
        label: ncxLabel(target) || attr(target, 'value') || '',
        href: ref.href,
        path: ref.path,
        fragment: ref.fragment,
      });
    } catch (cause) {
      diagnostics.push({
        ...diag(
          'NCX_PAGE_TARGET_INVALID',
          'warning',
          `Could not resolve NCX page target ${src}.`,
          ncxPath,
        ),
        cause,
      });
    }
  }
  return out;
}

function ncxLabel(element: XmlElementNode): string {
  const navLabel = firstChild(element, 'navLabel');
  const text = navLabel ? firstChild(navLabel, 'text') : undefined;
  return text ? textContent(text) : '';
}

function diag(
  code: string,
  severity: PublicationDiagnostic['severity'],
  message: string,
  path: PublicationPath,
): PublicationDiagnostic {
  return { code, severity, phase: 'navigation', message, path };
}

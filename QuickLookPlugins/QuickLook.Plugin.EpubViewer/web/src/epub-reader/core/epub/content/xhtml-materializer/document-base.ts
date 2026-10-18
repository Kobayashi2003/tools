import {
  resolvePublicationDocumentBase,
  resolvePublicationDocumentReference,
  type PublicationDiagnostic,
  type PublicationPath,
} from '../../publication';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface NeutralizedDocumentBases {
  readonly documentBaseHref?: string;
  readonly elementBaseHrefs: ReadonlyMap<Element, string | undefined>;
}

/** Resolve authored base semantics before neutralizing them in generated markup. */
export function neutralizeDocumentBases(
  document: Document,
  path: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): NeutralizedDocumentBases {
  const documentBaseHref = neutralizeHtmlBase(document, path, diagnostics);
  return {
    documentBaseHref,
    elementBaseHrefs: neutralizeXmlBases(
      document,
      path,
      documentBaseHref,
      diagnostics,
    ),
  };
}

function neutralizeHtmlBase(
  document: Document,
  path: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): string | undefined {
  const bases = Array.from(document.getElementsByTagNameNS(XHTML_NS, 'base'));
  for (const candidate of bases) {
    const target = candidate.getAttribute('target');
    if (target) {
      candidate.setAttribute('data-epub-authored-target', target);
      candidate.removeAttribute('target');
    }
  }

  const base = bases.find((element) => element.hasAttribute('href'));
  const href = base?.getAttribute('href')?.trim() || undefined;
  if (!base || !href) return undefined;

  base.setAttribute('data-epub-authored-href', href);
  base.removeAttribute('href');
  try {
    // Validate once so every later rewrite observes the same failure boundary.
    resolvePublicationDocumentReference(path, href, '');
    diagnostics.push({
      code: 'CONTENT_BASE_ELEMENT_USED',
      severity: 'info',
      phase: 'content',
      message: `Honored and neutralized authored <base href> while materializing ${path}.`,
      path,
    });
    return href;
  } catch (cause) {
    diagnostics.push({
      code: 'CONTENT_BASE_REFERENCE_INVALID',
      severity: 'warning',
      phase: 'content',
      message: `Ignored invalid <base href> in ${path}: ${href}.`,
      path,
      cause,
    });
    return undefined;
  }
}

function neutralizeXmlBases(
  document: Document,
  path: PublicationPath,
  documentBaseHref: string | undefined,
  diagnostics: PublicationDiagnostic[],
): ReadonlyMap<Element, string | undefined> {
  const resolvedBases = new Map<Element, string | undefined>();
  let applied = 0;

  for (const element of Array.from(document.getElementsByTagName('*'))) {
    const parentBase = element.parentElement
      ? (resolvedBases.get(element.parentElement) ?? documentBaseHref)
      : documentBaseHref;
    const authored = element.getAttributeNS(XML_NS, 'base')?.trim();
    let effective = parentBase;

    if (authored) {
      element.setAttribute('data-epub-authored-xml-base', authored);
      element.removeAttributeNS(XML_NS, 'base');
      try {
        effective = resolvePublicationDocumentBase(path, parentBase, authored);
        applied += 1;
      } catch (cause) {
        diagnostics.push({
          code: 'CONTENT_XML_BASE_REFERENCE_INVALID',
          severity: 'warning',
          phase: 'content',
          message: `Ignored invalid xml:base in ${path}: ${authored}.`,
          path,
          cause,
        });
      }
    }
    resolvedBases.set(element, effective);
  }

  if (applied > 0) {
    diagnostics.push({
      code: 'CONTENT_XML_BASE_APPLIED',
      severity: 'info',
      phase: 'compatibility',
      message: `Applied and neutralized ${applied} inherited xml:base declaration(s) while materializing ${path}.`,
      path,
      repair: {
        strategy: 'apply-nested-xml-base-semantics',
        description:
          'Resolve descendant resources and links against inherited XML Base declarations before generating isolated reader markup.',
        confidence: 0.99,
      },
    });
  }
  return resolvedBases;
}

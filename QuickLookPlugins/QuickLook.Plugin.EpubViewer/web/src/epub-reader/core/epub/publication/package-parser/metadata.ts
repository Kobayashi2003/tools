import {
  attr,
  childElements,
  textContent,
  type XmlElementNode,
} from '../../xml/xml';
import type {
  Contributor,
  MetadataEntry,
  PublicationDiagnostic,
  PublicationMetadata,
  PublicationPath,
  TextDirection,
} from '../model';
import { packageDiagnostic } from './diagnostics';

export function parsePackageMetadata(
  metadata: XmlElementNode | undefined,
  packageElement: XmlElementNode,
  diagnostics: PublicationDiagnostic[],
  packagePath: PublicationPath,
): PublicationMetadata {
  if (!metadata) return { creators: [], contributors: [], entries: [] };

  const children = childElements(metadata);
  const entries: MetadataEntry[] = [];
  const byId = new Map<string, XmlElementNode>();
  const refinements = new Map<string, XmlElementNode[]>();

  for (const element of children) {
    const id = attr(element, 'id');
    if (id) byId.set(id, element);

    if (element.localName === 'meta') {
      const property = attr(element, 'property') ?? attr(element, 'name');
      const value = attr(element, 'content') ?? textContent(element);
      const refines = attr(element, 'refines');
      if (property) {
        entries.push(metadataEntry(property, value, element));
        if (refines?.startsWith('#')) {
          const target = refines.slice(1);
          const list = refinements.get(target) ?? [];
          list.push(element);
          refinements.set(target, list);
        }
      }
      continue;
    }

    if (isDublinCoreElement(element)) {
      entries.push(
        metadataEntry(`dc:${element.localName}`, textContent(element), element),
      );
    }
  }

  const dc = (name: string) =>
    children.filter(
      (element) => element.localName === name && isDublinCoreElement(element),
    );
  const firstText = (name: string) => dc(name).map(textContent).find(Boolean);

  const uniqueIdentifierId = attr(packageElement, 'unique-identifier');
  let identifierElement = uniqueIdentifierId
    ? byId.get(uniqueIdentifierId)
    : undefined;
  if (!identifierElement || identifierElement.localName !== 'identifier') {
    identifierElement = dc('identifier')[0];
  }

  const identifier = identifierElement
    ? {
        value: textContent(identifierElement),
        scheme: identifierScheme(identifierElement, refinements),
      }
    : undefined;
  if (!identifier?.value) {
    diagnostics.push(
      packageDiagnostic(
        'PACKAGE_IDENTIFIER_MISSING',
        'error',
        'Publication identifier is missing.',
        packagePath,
      ),
    );
  }

  const titleElements = dc('title');
  const titleTypes = new Map<XmlElementNode, string | undefined>();
  for (const element of titleElements) {
    const id = attr(element, 'id');
    titleTypes.set(
      element,
      id ? findRefinementValue(refinements.get(id), 'title-type') : undefined,
    );
  }
  const mainTitle =
    titleElements.find((element) => titleTypes.get(element) === 'main') ??
    titleElements.find((element) => titleTypes.get(element) !== 'subtitle') ??
    titleElements[0];
  const subtitleElement = titleElements.find(
    (element) => titleTypes.get(element) === 'subtitle',
  );

  const creators = dc('creator').map((element) =>
    contributorFromElement(element, refinements),
  );
  const contributors = dc('contributor').map((element) =>
    contributorFromElement(element, refinements),
  );
  const modified = children
    .filter(
      (element) =>
        element.localName === 'meta' &&
        attr(element, 'property') === 'dcterms:modified' &&
        !attr(element, 'refines'),
    )
    .map(textContent)
    .find(Boolean);

  return {
    identifier,
    title: mainTitle ? textContent(mainTitle) || undefined : undefined,
    subtitle: subtitleElement ? textContent(subtitleElement) : undefined,
    language: firstText('language'),
    modified,
    publisher: firstText('publisher'),
    description: firstText('description'),
    rights: firstText('rights'),
    creators,
    contributors,
    entries,
  };
}

function contributorFromElement(
  element: XmlElementNode,
  refinements: ReadonlyMap<string, XmlElementNode[]>,
): Contributor {
  const id = attr(element, 'id');
  const refined = id ? refinements.get(id) : undefined;
  return {
    name: textContent(element),
    id,
    role:
      attr(element, 'opf:role', 'role') ?? findRefinementValue(refined, 'role'),
    fileAs:
      attr(element, 'opf:file-as', 'file-as') ??
      findRefinementValue(refined, 'file-as'),
  };
}

function identifierScheme(
  element: XmlElementNode,
  refinements: ReadonlyMap<string, XmlElementNode[]>,
): string | undefined {
  const legacy = attr(element, 'opf:scheme', 'scheme');
  if (legacy) return legacy;
  const id = attr(element, 'id');
  return id
    ? findRefinementValue(refinements.get(id), 'identifier-type')
    : undefined;
}

function findRefinementValue(
  elements: readonly XmlElementNode[] | undefined,
  property: string,
): string | undefined {
  const element = elements?.find(
    (candidate) => attr(candidate, 'property') === property,
  );
  return element ? textContent(element) : undefined;
}

function metadataEntry(
  property: string,
  value: string,
  element: XmlElementNode,
): MetadataEntry {
  const rawDirection = attr(element, 'dir');
  const direction: TextDirection | undefined =
    rawDirection === 'ltr' || rawDirection === 'rtl' || rawDirection === 'auto'
      ? rawDirection
      : undefined;
  return {
    property,
    value,
    id: attr(element, 'id'),
    refines: attr(element, 'refines'),
    scheme: attr(element, 'scheme', 'opf:scheme'),
    language: attr(element, 'xml:lang', 'lang'),
    direction,
  };
}

function isDublinCoreElement(element: XmlElementNode): boolean {
  const isDcNamespace =
    element.namespaceUri === 'http://purl.org/dc/elements/1.1/';
  if (!isDcNamespace && !element.name.startsWith('dc:')) return false;
  return [
    'identifier',
    'title',
    'language',
    'contributor',
    'coverage',
    'creator',
    'date',
    'description',
    'format',
    'publisher',
    'relation',
    'rights',
    'source',
    'subject',
    'type',
  ].includes(element.localName);
}

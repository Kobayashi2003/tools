import {
  attr,
  childElements,
  textContent,
  type XmlElementNode,
} from '../../xml/xml';
import type {
  PublicationDiagnostic,
  PublicationPath,
  PublicationRendition,
  RenditionFlow,
  RenditionLayout,
  RenditionOrientation,
  RenditionSpread,
  SpineRenditionOverrides,
} from '../model';
import { packageDiagnostic } from './diagnostics';

const DEFAULT_RENDITION: PublicationRendition = Object.freeze({
  layout: 'reflowable',
  orientation: 'auto',
  spread: 'auto',
  flow: 'auto',
});

export function parseGlobalRendition(
  metadata: XmlElementNode | undefined,
  diagnostics: PublicationDiagnostic[],
  packagePath: PublicationPath,
): PublicationRendition {
  if (!metadata) return DEFAULT_RENDITION;
  const metas = childElements(metadata, 'meta').filter(
    (meta) => !attr(meta, 'refines'),
  );
  const value = (property: string): string | undefined =>
    metas
      .filter((meta) => attr(meta, 'property') === property)
      .map(textContent)
      .find(Boolean);

  return {
    layout: enumValue(
      value('rendition:layout'),
      ['reflowable', 'pre-paginated'],
      'reflowable',
      'rendition:layout',
      diagnostics,
      packagePath,
    ),
    orientation: enumValue(
      value('rendition:orientation'),
      ['auto', 'portrait', 'landscape'],
      'auto',
      'rendition:orientation',
      diagnostics,
      packagePath,
    ),
    spread: enumValue(
      value('rendition:spread'),
      ['auto', 'none', 'landscape', 'portrait', 'both'],
      'auto',
      'rendition:spread',
      diagnostics,
      packagePath,
    ),
    flow: enumValue(
      value('rendition:flow'),
      ['auto', 'paginated', 'scrolled-continuous', 'scrolled-doc'],
      'auto',
      'rendition:flow',
      diagnostics,
      packagePath,
    ),
  } as PublicationRendition;
}

export function parseSpineRendition(
  properties: readonly string[],
  diagnostics: PublicationDiagnostic[],
  packagePath: PublicationPath,
  spineIndex: number,
): SpineRenditionOverrides {
  const rendition: {
    layout?: RenditionLayout;
    orientation?: RenditionOrientation;
    spread?: RenditionSpread;
    flow?: RenditionFlow;
    pageSpread?: 'left' | 'right' | 'center';
    alignXCenter?: boolean;
  } = {};

  applyExclusive('layout', [
    ['rendition:layout-reflowable', 'reflowable'],
    ['rendition:layout-pre-paginated', 'pre-paginated'],
  ] as const);
  applyExclusive('orientation', [
    ['rendition:orientation-auto', 'auto'],
    ['rendition:orientation-portrait', 'portrait'],
    ['rendition:orientation-landscape', 'landscape'],
  ] as const);
  applyExclusive('spread', [
    ['rendition:spread-auto', 'auto'],
    ['rendition:spread-none', 'none'],
    ['rendition:spread-landscape', 'landscape'],
    ['rendition:spread-portrait', 'portrait'],
    ['rendition:spread-both', 'both'],
  ] as const);
  applyExclusive('flow', [
    ['rendition:flow-auto', 'auto'],
    ['rendition:flow-paginated', 'paginated'],
    ['rendition:flow-scrolled-continuous', 'scrolled-continuous'],
    ['rendition:flow-scrolled-doc', 'scrolled-doc'],
  ] as const);

  const placementByToken = new Map<string, 'left' | 'right' | 'center'>([
    ['rendition:page-spread-left', 'left'],
    ['page-spread-left', 'left'],
    ['rendition:page-spread-right', 'right'],
    ['page-spread-right', 'right'],
    ['rendition:page-spread-center', 'center'],
  ]);
  const placementHits = properties
    .map((token) => [token, placementByToken.get(token)] as const)
    .filter(
      (entry): entry is readonly [string, 'left' | 'right' | 'center'] =>
        entry[1] !== undefined,
    );
  if (new Set(placementHits.map(([, value]) => value)).size > 1) {
    diagnostics.push({
      ...packageDiagnostic(
        'PACKAGE_SPINE_PAGE_SPREAD_CONFLICT',
        'error',
        'Spine item declares conflicting page-spread properties; the first authored value is used for reading-system recovery.',
        packagePath,
      ),
      spineIndex,
      repair: {
        strategy: 'use-first-authored-page-spread',
        description:
          'Use the first authored page-spread token and ignore conflicting later tokens.',
        confidence: 1,
      },
    });
  }
  if (placementHits[0]) rendition.pageSpread = placementHits[0][1];
  if (properties.includes('rendition:align-x-center'))
    rendition.alignXCenter = true;
  return rendition;

  function applyExclusive<
    K extends 'layout' | 'orientation' | 'spread' | 'flow',
    V extends NonNullable<(typeof rendition)[K]>,
  >(key: K, mappings: readonly (readonly [string, V])[]): void {
    const valueByToken = new Map<string, V>(mappings);
    const hits = properties
      .map((token) => [token, valueByToken.get(token)] as const)
      .filter((entry): entry is readonly [string, V] => entry[1] !== undefined);
    if (new Set(hits.map(([, value]) => value)).size > 1) {
      diagnostics.push({
        ...packageDiagnostic(
          'PACKAGE_SPINE_RENDITION_CONFLICT',
          'error',
          `Spine item declares conflicting rendition ${key} overrides; the first authored value is used for reading-system recovery.`,
          packagePath,
        ),
        spineIndex,
        repair: {
          strategy: 'use-first-authored-rendition-override',
          description: `Use the first authored rendition ${key} override and ignore conflicting later tokens.`,
          confidence: 1,
        },
      });
    }
    if (hits[0]) (rendition as Record<string, unknown>)[key] = hits[0][1];
  }
}

function enumValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  property: string,
  diagnostics: PublicationDiagnostic[],
  packagePath: PublicationPath,
): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  diagnostics.push(
    packageDiagnostic(
      'PACKAGE_RENDITION_VALUE_INVALID',
      'warning',
      `Unknown ${property} value ${JSON.stringify(value)}; specification default ${fallback} is used.`,
      packagePath,
    ),
  );
  return fallback;
}

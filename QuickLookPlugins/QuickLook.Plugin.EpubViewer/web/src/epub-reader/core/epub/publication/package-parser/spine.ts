import {
  attr,
  childElements,
  tokenList,
  type XmlElementNode,
} from '../../xml/xml';
import type {
  ManifestItem,
  PageProgressionDirection,
  PublicationDiagnostic,
  PublicationPath,
  SpineItem,
} from '../model';
import { packageDiagnostic } from './diagnostics';
import { parseSpineRendition } from './rendition';

export interface ParsedPackageSpine {
  readonly spine: SpineItem[];
  readonly progression: PageProgressionDirection;
}

export function parsePackageSpine(
  packageElement: XmlElementNode,
  spineElement: XmlElementNode,
  manifestById: ReadonlyMap<string, ManifestItem>,
  diagnostics: PublicationDiagnostic[],
  packagePath: PublicationPath,
): ParsedPackageSpine {
  const progression = parseProgression(spineElement, diagnostics, packagePath);
  const spine: SpineItem[] = [];
  const spineStep = cfiElementStep(packageElement, spineElement);

  for (const element of childElements(spineElement, 'itemref')) {
    const idref = attr(element, 'idref');
    if (!idref) {
      diagnostics.push(
        packageDiagnostic(
          'PACKAGE_SPINE_IDREF_MISSING',
          'error',
          'Spine itemref is missing idref.',
          packagePath,
        ),
      );
      continue;
    }

    const manifest = manifestById.get(idref);
    if (!manifest) {
      diagnostics.push(
        packageDiagnostic(
          'PACKAGE_SPINE_IDREF_UNRESOLVED',
          'error',
          `Spine idref ${idref} does not resolve to a manifest item.`,
          packagePath,
        ),
      );
      continue;
    }

    const properties = tokenList(attr(element, 'properties'));
    const itemrefId = attr(element, 'id');
    spine.push({
      index: spine.length,
      idref,
      ...(itemrefId ? { itemrefId } : {}),
      cfiBase: `${spineStep}${cfiElementStep(spineElement, element)}!`,
      href: manifest.href,
      path: manifest.path,
      remote: manifest.remote,
      mediaType: manifest.mediaType,
      linear: attr(element, 'linear') !== 'no',
      properties,
      rendition: parseSpineRendition(
        properties,
        diagnostics,
        packagePath,
        spine.length,
      ),
    });
  }
  return { spine, progression };
}

function parseProgression(
  spineElement: XmlElementNode,
  diagnostics: PublicationDiagnostic[],
  packagePath: PublicationPath,
): PageProgressionDirection {
  const raw = attr(spineElement, 'page-progression-direction');
  if (!raw || raw === 'default') return 'default';
  if (raw === 'ltr' || raw === 'rtl') return raw;

  diagnostics.push(
    packageDiagnostic(
      'PACKAGE_PAGE_PROGRESSION_INVALID',
      'warning',
      `Unknown page-progression-direction: ${raw}.`,
      packagePath,
    ),
  );
  return 'default';
}

function cfiElementStep(parent: XmlElementNode, child: XmlElementNode): string {
  const index = childElements(parent).indexOf(child);
  if (index < 0) {
    throw new Error('Cannot compute CFI step for a non-child package element.');
  }
  const id = attr(child, 'id');
  return `/${(index + 1) * 2}${id ? `[${escapeCfiAssertion(id)}]` : ''}`;
}

function escapeCfiAssertion(value: string): string {
  return value.replace(/[\]^,();]|\[/g, (character) => `^${character}`);
}

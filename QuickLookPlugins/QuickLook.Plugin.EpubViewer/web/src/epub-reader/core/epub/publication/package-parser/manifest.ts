import {
  attr,
  childElements,
  tokenList,
  type XmlElementNode,
} from '../../xml/xml';
import type {
  ManifestItem,
  PublicationDiagnostic,
  PublicationPath,
} from '../model';
import { resolvePublicationReference } from '../path';
import { packageDiagnostic } from './diagnostics';

export function parsePackageManifest(
  manifestElement: XmlElementNode,
  diagnostics: PublicationDiagnostic[],
  packagePath: PublicationPath,
): ManifestItem[] {
  const items: ManifestItem[] = [];
  for (const element of childElements(manifestElement, 'item')) {
    const id = attr(element, 'id');
    const sourceHref = attr(element, 'href');
    const mediaType = attr(element, 'media-type');
    if (!id || !sourceHref || !mediaType) {
      diagnostics.push(
        packageDiagnostic(
          'PACKAGE_MANIFEST_ITEM_INVALID',
          'error',
          'Manifest item is missing id, href, or media-type.',
          packagePath,
        ),
      );
      continue;
    }

    try {
      const reference = resolvePublicationReference(packagePath, sourceHref);
      items.push({
        id,
        sourceHref,
        href: reference.href,
        path: reference.path,
        remote: reference.remote,
        mediaType,
        mediaOverlay: attr(element, 'media-overlay'),
        fallback: attr(element, 'fallback'),
        properties: tokenList(attr(element, 'properties')),
      });
    } catch (cause) {
      diagnostics.push({
        ...packageDiagnostic(
          'PACKAGE_MANIFEST_HREF_INVALID',
          'error',
          `Manifest href could not be resolved: ${sourceHref}.`,
          packagePath,
        ),
        cause,
      });
    }
  }
  return items;
}

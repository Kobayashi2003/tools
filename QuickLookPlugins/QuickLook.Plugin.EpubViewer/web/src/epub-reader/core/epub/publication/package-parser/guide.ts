import { attr, childElements, type XmlElementNode } from '../../xml/xml';
import type {
  Landmark,
  PublicationDiagnostic,
  PublicationPath,
} from '../model';
import { resolvePublicationReference } from '../path';
import { packageDiagnostic } from './diagnostics';

export function parsePackageGuide(
  guide: XmlElementNode | undefined,
  packagePath: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): Landmark[] {
  if (!guide) return [];
  const landmarks: Landmark[] = [];
  for (const reference of childElements(guide, 'reference')) {
    const type = attr(reference, 'type');
    const href = attr(reference, 'href');
    if (!type || !href) continue;

    try {
      const resolved = resolvePublicationReference(packagePath, href);
      landmarks.push({
        types: [type],
        label: attr(reference, 'title'),
        href: resolved.href,
        path: resolved.path,
        fragment: resolved.fragment,
      });
    } catch (cause) {
      diagnostics.push({
        ...packageDiagnostic(
          'PACKAGE_GUIDE_HREF_INVALID',
          'warning',
          `EPUB 2 guide href could not be resolved: ${href}.`,
          packagePath,
        ),
        cause,
      });
    }
  }
  return landmarks;
}

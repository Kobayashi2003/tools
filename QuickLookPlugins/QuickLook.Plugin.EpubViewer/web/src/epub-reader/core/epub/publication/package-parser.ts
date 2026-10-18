import { attr, firstChild, parseXml, type XmlElementNode } from '../xml/xml';
import type {
  EpubVersion,
  Landmark,
  ManifestItem,
  Publication,
  PublicationDiagnostic,
  PublicationPath,
} from './model';
import { packageDiagnostic } from './package-parser/diagnostics';
import { parsePackageGuide } from './package-parser/guide';
import { parsePackageManifest } from './package-parser/manifest';
import { parsePackageMetadata } from './package-parser/metadata';
import { parseGlobalRendition } from './package-parser/rendition';
import { parsePackageSpine } from './package-parser/spine';

export interface ParsedPackageDocument {
  readonly publication: Publication | null;
  readonly navigationItem?: ManifestItem;
  readonly ncxItem?: ManifestItem;
  readonly epub2Guide: readonly Landmark[];
  readonly diagnostics: readonly PublicationDiagnostic[];
}

/** Parse an OPF package by delegating each top-level section to its own parser. */
export function parsePackageDocument(
  xml: string,
  packagePath: PublicationPath,
): ParsedPackageDocument {
  const parsed = parseXml(xml, packagePath, 'package');
  const diagnostics = [...parsed.diagnostics];
  const root = parsed.root;
  if (!root || root.localName !== 'package') {
    diagnostics.push(
      packageDiagnostic(
        'PACKAGE_ROOT_INVALID',
        'fatal',
        'Package document does not have a <package> root.',
        packagePath,
      ),
    );
    return emptyPackageResult(diagnostics);
  }

  const metadataElement = firstChild(root, 'metadata');
  const manifestElement = firstChild(root, 'manifest');
  const spineElement = firstChild(root, 'spine');
  reportMissingSections(
    metadataElement != null,
    manifestElement != null,
    spineElement != null,
    packagePath,
    diagnostics,
  );
  if (!manifestElement || !spineElement) return emptyPackageResult(diagnostics);

  const version = (attr(root, 'version') ?? 'unknown') as EpubVersion;
  const metadata = parsePackageMetadata(
    metadataElement,
    root,
    diagnostics,
    packagePath,
  );
  const rendition = parseGlobalRendition(
    metadataElement,
    diagnostics,
    packagePath,
  );
  const manifest = parsePackageManifest(
    manifestElement,
    diagnostics,
    packagePath,
  );
  const manifestById = new Map(manifest.map((item) => [item.id, item]));
  const { spine, progression } = parsePackageSpine(
    root,
    spineElement,
    manifestById,
    diagnostics,
    packagePath,
  );
  const epub2Guide = parsePackageGuide(
    firstChild(root, 'guide'),
    packagePath,
    diagnostics,
  );

  const navigationItem = manifest.find((item) =>
    item.properties.includes('nav'),
  );
  const ncxItem = resolveNcxItem(spineElement, manifest, manifestById);
  if (version.startsWith('3') && !navigationItem) {
    diagnostics.push(
      packageDiagnostic(
        'PACKAGE_NAV_ITEM_MISSING',
        'error',
        'EPUB 3 package has no manifest item with the `nav` property.',
        packagePath,
      ),
    );
  }

  const publication: Publication = {
    version,
    packagePath,
    metadata,
    manifest,
    spine,
    navigation: { source: 'none', toc: [], landmarks: [], pageList: [] },
    pageProgressionDirection: progression,
    rendition,
  };

  return {
    publication,
    navigationItem,
    ncxItem,
    epub2Guide,
    diagnostics,
  };
}

function reportMissingSections(
  hasMetadata: boolean,
  hasManifest: boolean,
  hasSpine: boolean,
  packagePath: PublicationPath,
  diagnostics: PublicationDiagnostic[],
): void {
  if (!hasMetadata) {
    diagnostics.push(
      packageDiagnostic(
        'PACKAGE_METADATA_MISSING',
        'error',
        'Package document is missing <metadata>.',
        packagePath,
      ),
    );
  }
  if (!hasManifest) {
    diagnostics.push(
      packageDiagnostic(
        'PACKAGE_MANIFEST_MISSING',
        'fatal',
        'Package document is missing <manifest>.',
        packagePath,
      ),
    );
  }
  if (!hasSpine) {
    diagnostics.push(
      packageDiagnostic(
        'PACKAGE_SPINE_MISSING',
        'fatal',
        'Package document is missing <spine>.',
        packagePath,
      ),
    );
  }
}

function resolveNcxItem(
  spineElement: XmlElementNode,
  manifest: readonly ManifestItem[],
  manifestById: ReadonlyMap<string, ManifestItem>,
): ManifestItem | undefined {
  const spineTocId = attr(spineElement, 'toc');
  return spineTocId
    ? manifestById.get(spineTocId)
    : manifest.find((item) => item.mediaType === 'application/x-dtbncx+xml');
}

function emptyPackageResult(
  diagnostics: readonly PublicationDiagnostic[],
): ParsedPackageDocument {
  return { publication: null, epub2Guide: [], diagnostics };
}

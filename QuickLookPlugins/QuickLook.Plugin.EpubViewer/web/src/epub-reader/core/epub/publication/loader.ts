import type { PublicationArchive } from '../archive/publication-archive';
import type { OcfZipLimits } from '../archive/ocf-zip';
import { openPublicationArchive } from '../archive/publication-format';
import { createBuiltInCompatibilityProfile } from '../compatibility/built-in-rules';
import type { CompatibilityProfile } from '../compatibility/profile';
import {
  runNavigationFallbackCompatibility,
  runRootfileSelectionCompatibility,
} from '../compatibility/publication-runner';
import { parseContainerDocument } from './container-parser';
import { validatePublicationModel } from './invariants';
import {
  DEFAULT_READER_COMPATIBILITY_PREFERENCES,
  type NavigationModel,
  type Publication,
  type PublicationDiagnostic,
  type PublicationLoadResult,
  type PublicationPath,
} from './model';
import { parseNavigationDocument } from './navigation-parser';
import { parseNcxDocument } from './ncx-parser';
import { parsePackageDocument } from './package-parser';

const CONTAINER_PATH: PublicationPath = 'META-INF/container.xml';

export interface PublicationControlDocumentLimits {
  readonly maxContainerXmlBytes: number;
  readonly maxPackageDocumentBytes: number;
  readonly maxNavigationDocumentBytes: number;
}

export const DEFAULT_PUBLICATION_CONTROL_DOCUMENT_LIMITS: PublicationControlDocumentLimits =
  Object.freeze({
    maxContainerXmlBytes: 1024 * 1024,
    maxPackageDocumentBytes: 8 * 1024 * 1024,
    maxNavigationDocumentBytes: 16 * 1024 * 1024,
  });

export interface LoadEpubOptions {
  readonly archiveLimits?: Partial<OcfZipLimits>;
  readonly controlDocumentLimits?: Partial<PublicationControlDocumentLimits>;
  readonly compatibilityProfile?: CompatibilityProfile;
}

export async function loadEpub(
  source: Uint8Array | ArrayBuffer,
  options: LoadEpubOptions = {},
): Promise<PublicationLoadResult> {
  const opened = await openPublicationArchive(source, options.archiveLimits);
  if (!opened.archive)
    return { publication: null, diagnostics: opened.diagnostics };
  return loadPublicationFromArchive(opened.archive, opened.diagnostics, {
    controlDocumentLimits: options.controlDocumentLimits,
    compatibilityProfile: options.compatibilityProfile,
  });
}

/**
 * Parse a publication from an already-open archive. Keeping this boundary lets
 * tests, future streaming sources and remote/container adapters reuse the same
 * package/navigation parser without pretending that ZIP is the publication model.
 */
export interface LoadPublicationFromArchiveOptions {
  readonly controlDocumentLimits?: Partial<PublicationControlDocumentLimits>;
  readonly compatibilityProfile?: CompatibilityProfile;
}

export async function loadPublicationFromArchive(
  archive: PublicationArchive,
  initialDiagnostics: readonly PublicationDiagnostic[] = [],
  options: LoadPublicationFromArchiveOptions = {},
): Promise<PublicationLoadResult> {
  const diagnostics: PublicationDiagnostic[] = [...initialDiagnostics];
  const controlLimits = {
    ...DEFAULT_PUBLICATION_CONTROL_DOCUMENT_LIMITS,
    ...options.controlDocumentLimits,
  };
  const compatibilityProfile =
    options.compatibilityProfile ??
    createBuiltInCompatibilityProfile(DEFAULT_READER_COMPATIBILITY_PREFERENCES);

  if (!archive.has(CONTAINER_PATH)) {
    diagnostics.push({
      code: 'OCF_CONTAINER_MISSING',
      severity: 'fatal',
      phase: 'container',
      message: `Required ${CONTAINER_PATH} is missing.`,
      path: CONTAINER_PATH,
    });
    return { publication: null, diagnostics };
  }

  let containerXml: string;
  try {
    const bytes = await archive.read(CONTAINER_PATH);
    if (bytes.byteLength > controlLimits.maxContainerXmlBytes) {
      diagnostics.push({
        code: 'OCF_CONTAINER_DOCUMENT_LIMIT_EXCEEDED',
        severity: 'fatal',
        phase: 'container',
        message: `${CONTAINER_PATH} is ${bytes.byteLength} bytes, above the configured ${controlLimits.maxContainerXmlBytes}-byte control-document limit.`,
        path: CONTAINER_PATH,
      });
      return { publication: null, diagnostics };
    }
    containerXml = new TextDecoder('utf-8').decode(bytes);
  } catch (cause) {
    diagnostics.push({
      code: 'OCF_CONTAINER_READ_FAILED',
      severity: 'fatal',
      phase: 'container',
      message: `Failed to read ${CONTAINER_PATH}.`,
      path: CONTAINER_PATH,
      cause,
    });
    return { publication: null, diagnostics };
  }

  const container = parseContainerDocument(containerXml, CONTAINER_PATH);
  diagnostics.push(...container.diagnostics);
  const selectedRootfile = await runRootfileSelectionCompatibility(
    compatibilityProfile.publicationRules,
    { containerPath: CONTAINER_PATH, rootfiles: container.rootfiles },
    container.rootfiles[0] ?? null,
  );
  diagnostics.push(...selectedRootfile.diagnostics);
  const preferred = selectedRootfile.value;
  if (!preferred) return { publication: null, diagnostics };

  if (container.rootfiles.length > 1) {
    diagnostics.push({
      code: 'OCF_MULTIPLE_RENDITIONS_PRESENT',
      severity: 'info',
      phase: 'container',
      message: `container.xml declares ${container.rootfiles.length} package documents; the reading system selects ${preferred.fullPath}.`,
      path: CONTAINER_PATH,
      repair: {
        strategy:
          preferred === container.rootfiles[0]
            ? 'select-first-rootfile'
            : 'select-preferred-rootfile',
        description:
          preferred === container.rootfiles[0]
            ? 'Use the first package rootfile in publisher order.'
            : 'Select a compatible package rootfile from the validated container candidates.',
        confidence: 0.8,
      },
    });
  }

  if (!archive.has(preferred.fullPath)) {
    diagnostics.push({
      code: 'PACKAGE_DOCUMENT_MISSING',
      severity: 'fatal',
      phase: 'package',
      message: `Package document ${preferred.fullPath} is not present in the container.`,
      path: preferred.fullPath,
    });
    return { publication: null, diagnostics };
  }

  let packageXml: string;
  try {
    const bytes = await archive.read(preferred.fullPath);
    if (bytes.byteLength > controlLimits.maxPackageDocumentBytes) {
      diagnostics.push({
        code: 'PACKAGE_DOCUMENT_LIMIT_EXCEEDED',
        severity: 'fatal',
        phase: 'package',
        message: `Package document ${preferred.fullPath} is ${bytes.byteLength} bytes, above the configured ${controlLimits.maxPackageDocumentBytes}-byte limit.`,
        path: preferred.fullPath,
      });
      return { publication: null, diagnostics };
    }
    packageXml = new TextDecoder('utf-8').decode(bytes);
  } catch (cause) {
    diagnostics.push({
      code: 'PACKAGE_DOCUMENT_READ_FAILED',
      severity: 'fatal',
      phase: 'package',
      message: `Failed to read package document ${preferred.fullPath}.`,
      path: preferred.fullPath,
      cause,
    });
    return { publication: null, diagnostics };
  }

  const parsedPackage = parsePackageDocument(packageXml, preferred.fullPath);
  diagnostics.push(...parsedPackage.diagnostics);
  if (!parsedPackage.publication) return { publication: null, diagnostics };

  let navigation: NavigationModel = parsedPackage.publication.navigation;

  // EPUB 3 Navigation Document is authoritative when available.
  const nav = parsedPackage.navigationItem;
  if (nav?.path) {
    const result = await tryParseNavigation(
      archive,
      nav.path,
      diagnostics,
      controlLimits.maxNavigationDocumentBytes,
    );
    if (result) navigation = result;
  }

  let legacyNavigation: NavigationModel | undefined;
  const hasNavigationFallbackRules = compatibilityProfile.publicationRules.some(
    (rule) => rule.stage === 'publication.navigation-fallback',
  );
  if (
    hasNavigationFallbackRules &&
    navigation.toc.length === 0 &&
    parsedPackage.ncxItem?.path
  ) {
    legacyNavigation =
      (await tryParseNcx(
        archive,
        parsedPackage.ncxItem.path,
        diagnostics,
        controlLimits.maxNavigationDocumentBytes,
      )) ?? undefined;
  }
  const compatibleNavigation = await runNavigationFallbackCompatibility(
    compatibilityProfile.publicationRules,
    {
      publication: parsedPackage.publication,
      primaryNavigation: navigation,
      legacyNavigation,
      legacyLandmarks: parsedPackage.epub2Guide,
    },
    navigation,
  );
  diagnostics.push(...compatibleNavigation.diagnostics);
  navigation = compatibleNavigation.value;

  const publication: Publication = {
    ...parsedPackage.publication,
    navigation,
  };
  diagnostics.push(...validatePublicationModel(publication));

  return { publication, diagnostics };
}

async function tryParseNavigation(
  archive: PublicationArchive,
  path: PublicationPath,
  diagnostics: PublicationDiagnostic[],
  maxBytes: number,
): Promise<NavigationModel | null> {
  if (!archive.has(path)) {
    diagnostics.push({
      code: 'NAV_DOCUMENT_MISSING',
      severity: 'error',
      phase: 'navigation',
      message: `Navigation Document ${path} is missing from the container.`,
      path,
    });
    return null;
  }
  try {
    const bytes = await archive.read(path);
    if (bytes.byteLength > maxBytes) {
      diagnostics.push({
        code: 'NAV_DOCUMENT_LIMIT_EXCEEDED',
        severity: 'error',
        phase: 'navigation',
        message: `Navigation Document ${path} is ${bytes.byteLength} bytes, above the configured ${maxBytes}-byte limit.`,
        path,
      });
      return null;
    }
    const parsed = parseNavigationDocument(
      new TextDecoder('utf-8').decode(bytes),
      path,
    );
    diagnostics.push(...parsed.diagnostics);
    return parsed.navigation;
  } catch (cause) {
    diagnostics.push({
      code: 'NAV_DOCUMENT_READ_FAILED',
      severity: 'error',
      phase: 'navigation',
      message: `Failed to read Navigation Document ${path}.`,
      path,
      cause,
    });
    return null;
  }
}

async function tryParseNcx(
  archive: PublicationArchive,
  path: PublicationPath,
  diagnostics: PublicationDiagnostic[],
  maxBytes: number,
): Promise<NavigationModel | null> {
  if (!archive.has(path)) {
    diagnostics.push({
      code: 'NCX_DOCUMENT_MISSING',
      severity: 'warning',
      phase: 'navigation',
      message: `NCX document ${path} is missing from the container.`,
      path,
    });
    return null;
  }
  try {
    const bytes = await archive.read(path);
    if (bytes.byteLength > maxBytes) {
      diagnostics.push({
        code: 'NCX_DOCUMENT_LIMIT_EXCEEDED',
        severity: 'warning',
        phase: 'navigation',
        message: `NCX document ${path} is ${bytes.byteLength} bytes, above the configured ${maxBytes}-byte limit.`,
        path,
      });
      return null;
    }
    const parsed = parseNcxDocument(
      new TextDecoder('utf-8').decode(bytes),
      path,
    );
    diagnostics.push(...parsed.diagnostics);
    return parsed.navigation;
  } catch (cause) {
    diagnostics.push({
      code: 'NCX_DOCUMENT_READ_FAILED',
      severity: 'warning',
      phase: 'navigation',
      message: `Failed to read NCX document ${path}.`,
      path,
      cause,
    });
    return null;
  }
}

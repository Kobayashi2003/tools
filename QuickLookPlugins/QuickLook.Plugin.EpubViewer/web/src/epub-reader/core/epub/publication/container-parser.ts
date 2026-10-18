import type { PublicationDiagnostic, PublicationPath } from './model';
import { normalizePublicationPath, resolvePublicationReference } from './path';
import { attr, childElements, firstChild, parseXml } from '../xml/xml';

export interface ContainerRootfile {
  readonly fullPath: PublicationPath;
  readonly mediaType: string;
}

export interface ContainerParseResult {
  readonly rootfiles: readonly ContainerRootfile[];
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export function parseContainerDocument(
  xml: string,
  path: PublicationPath = 'META-INF/container.xml',
): ContainerParseResult {
  const parsed = parseXml(xml, path, 'container');
  const diagnostics = [...parsed.diagnostics];
  const root = parsed.root;

  if (!root || root.localName !== 'container') {
    diagnostics.push({
      code: 'OCF_CONTAINER_ROOT_INVALID',
      severity: 'fatal',
      phase: 'container',
      message:
        'META-INF/container.xml does not have a <container> root element.',
      path,
    });
    return { rootfiles: [], diagnostics };
  }

  if (attr(root, 'version') !== '1.0') {
    diagnostics.push({
      code: 'OCF_CONTAINER_VERSION_UNEXPECTED',
      severity: 'warning',
      phase: 'container',
      message: `Unexpected container version ${JSON.stringify(attr(root, 'version'))}; EPUB OCF requires 1.0.`,
      path,
    });
  }

  const rootfilesElement = firstChild(root, 'rootfiles');
  if (!rootfilesElement) {
    diagnostics.push({
      code: 'OCF_ROOTFILES_MISSING',
      severity: 'fatal',
      phase: 'container',
      message: 'container.xml is missing the required <rootfiles> element.',
      path,
    });
    return { rootfiles: [], diagnostics };
  }

  const rootfiles: ContainerRootfile[] = [];
  for (const element of childElements(rootfilesElement, 'rootfile')) {
    const fullPath = attr(element, 'full-path');
    const mediaType = attr(element, 'media-type');
    if (!fullPath || !mediaType) {
      diagnostics.push({
        code: 'OCF_ROOTFILE_ATTRIBUTES_MISSING',
        severity: 'error',
        phase: 'container',
        message: 'A <rootfile> is missing full-path or media-type.',
        path,
      });
      continue;
    }

    try {
      const ref = resolvePublicationReference('', fullPath);
      if (ref.remote || !ref.path)
        throw new Error('rootfile must resolve inside the EPUB container');
      rootfiles.push({
        fullPath: normalizePublicationPath(ref.path),
        mediaType,
      });
    } catch (cause) {
      diagnostics.push({
        code: 'OCF_ROOTFILE_PATH_INVALID',
        severity: 'error',
        phase: 'container',
        message: `Invalid rootfile path: ${fullPath}.`,
        path,
        cause,
      });
    }
  }

  if (rootfiles.length === 0) {
    diagnostics.push({
      code: 'OCF_ROOTFILE_NONE',
      severity: 'fatal',
      phase: 'container',
      message: 'container.xml does not identify a usable package document.',
      path,
    });
  }

  return { rootfiles, diagnostics };
}

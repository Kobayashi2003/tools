import type { PublicationArchive } from '../archive/publication-archive';
import type {
  Publication,
  PublicationDiagnostic,
  PublicationPath,
} from '../publication/model';
import { resolvePublicationReference } from '../publication/path';
import { attr, descendants, firstChild, parseXml } from '../xml/xml';

export const IDPF_FONT_OBFUSCATION = 'http://www.idpf.org/2008/embedding';
const ENCRYPTION_PATH: PublicationPath = 'META-INF/encryption.xml';

export interface EncryptedResourceInfo {
  readonly path: PublicationPath;
  readonly algorithm: string;
}

export interface EncryptionLoadResult {
  readonly resources: ReadonlyMap<PublicationPath, EncryptedResourceInfo>;
  readonly diagnostics: readonly PublicationDiagnostic[];
}

export async function loadContainerEncryption(
  archive: PublicationArchive,
): Promise<EncryptionLoadResult> {
  const diagnostics: PublicationDiagnostic[] = [];
  const resources = new Map<PublicationPath, EncryptedResourceInfo>();
  if (!archive.has(ENCRYPTION_PATH)) return { resources, diagnostics };

  let xml: string;
  try {
    xml = await archive.readText(ENCRYPTION_PATH);
  } catch (cause) {
    diagnostics.push({
      code: 'ENCRYPTION_DOCUMENT_READ_FAILED',
      severity: 'error',
      phase: 'resource',
      message: `Failed to read ${ENCRYPTION_PATH}.`,
      path: ENCRYPTION_PATH,
      cause,
    });
    return { resources, diagnostics };
  }

  const parsed = parseXml(xml, ENCRYPTION_PATH, 'resource');
  diagnostics.push(...parsed.diagnostics);
  if (!parsed.root) return { resources, diagnostics };

  for (const encryptedData of descendants(parsed.root, 'EncryptedData')) {
    const method = firstChild(encryptedData, 'EncryptionMethod');
    const cipherData = firstChild(encryptedData, 'CipherData');
    const reference = cipherData
      ? firstChild(cipherData, 'CipherReference')
      : undefined;
    const algorithm = method ? attr(method, 'Algorithm') : undefined;
    const uri = reference ? attr(reference, 'URI') : undefined;
    if (!algorithm || !uri) {
      diagnostics.push({
        code: 'ENCRYPTION_ENTRY_INCOMPLETE',
        severity: 'warning',
        phase: 'resource',
        message:
          'EncryptedData entry is missing EncryptionMethod@Algorithm or CipherReference@URI.',
        path: ENCRYPTION_PATH,
      });
      continue;
    }

    try {
      // OCF CipherReference paths are container-root references, not paths
      // relative to META-INF/encryption.xml.
      const resolved = resolvePublicationReference('', uri);
      if (resolved.remote || !resolved.path) {
        diagnostics.push({
          code: 'ENCRYPTION_REMOTE_REFERENCE_UNSUPPORTED',
          severity: 'warning',
          phase: 'resource',
          message: `Encryption metadata references a non-container resource: ${uri}.`,
          path: ENCRYPTION_PATH,
        });
        continue;
      }
      resources.set(resolved.path, { path: resolved.path, algorithm });
    } catch (cause) {
      diagnostics.push({
        code: 'ENCRYPTION_REFERENCE_INVALID',
        severity: 'warning',
        phase: 'resource',
        message: `Invalid CipherReference URI: ${uri}.`,
        path: ENCRYPTION_PATH,
        cause,
      });
    }
  }

  return { resources, diagnostics };
}

export async function deobfuscateIdpfFont(
  bytes: Uint8Array,
  publication: Publication,
): Promise<Uint8Array> {
  const identifier = publication.metadata.identifier?.value;
  if (!identifier)
    throw new Error(
      'IDPF font obfuscation requires the package unique identifier.',
    );

  const normalized = identifier.replace(/\s/g, '');
  const keyBuffer = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(normalized),
  );
  const key = new Uint8Array(keyBuffer);
  const output = bytes.slice();
  const limit = Math.min(1040, output.length);
  for (let i = 0; i < limit; i += 1)
    output[i] = output[i]! ^ key[i % key.length]!;
  return output;
}

import type { PublicationDiagnostic } from '../publication/model';
import { Kf8FormatError } from './kf8-archive/binary';
import { readKf8Book } from './kf8-archive/book';
import { synthesizeEpubFiles } from './kf8-archive/epub-package';
import { readKf8Header } from './kf8-archive/mobi-header';
import { PalmDatabase } from './kf8-archive/palm-database';
import type { OcfZipLimits } from './ocf-zip';
import {
  MemoryPublicationArchive,
  type PublicationArchiveOpenResult,
} from './publication-archive';

/**
 * Open a Kindle KF8 (AZW3, or the KF8 half of a combined MOBI) book as an EPUB
 * archive. The book is reassembled into XHTML parts, stylesheets and resources,
 * then described by a synthesized package and navigation document, so the
 * EPUB loading, compatibility and rendering pipeline applies unchanged.
 */
export async function openKf8Archive(
  bytes: Uint8Array,
  limits: OcfZipLimits,
): Promise<PublicationArchiveOpenResult> {
  const diagnostics: PublicationDiagnostic[] = [];
  const fatal = (code: string, message: string, cause?: unknown) => {
    diagnostics.push({
      code,
      severity: 'fatal',
      phase: 'archive',
      message,
      ...(cause ? { cause } : {}),
    });
    return { archive: null, diagnostics };
  };
  if (bytes.byteLength > limits.maxContainerBytes)
    return fatal(
      'KF8_CONTAINER_LIMIT_EXCEEDED',
      `Kindle book is ${bytes.byteLength} bytes, above the configured ${limits.maxContainerBytes}-byte safety limit.`,
    );
  try {
    const database = PalmDatabase.parse(bytes, limits.maxEntries);
    const { header, primary } = readKf8Header(database);
    if (header.encrypted || primary.encrypted)
      return fatal(
        'KF8_DRM_PROTECTED',
        'This Kindle book is protected by DRM and cannot be opened.',
      );
    const book = await readKf8Book(
      database,
      header,
      primary,
      limits.maxEntryUncompressedBytes,
      diagnostics,
    );
    if (book.parts.length === 0)
      return fatal(
        'KF8_TEXT_MISSING',
        'The Kindle book contains no readable text.',
      );
    diagnostics.push({
      code: 'KF8_CONVERTED',
      severity: 'info',
      phase: 'archive',
      message: `Opened a Kindle KF8 book as ${book.parts.length} EPUB content documents.`,
    });
    return {
      archive: new MemoryPublicationArchive(synthesizeEpubFiles(book)),
      diagnostics,
    };
  } catch (cause) {
    if (cause instanceof Kf8FormatError)
      return fatal('KF8_STRUCTURE_INVALID', cause.message, cause);
    return fatal(
      'KF8_OPEN_FAILED',
      'The Kindle book could not be read.',
      cause,
    );
  }
}

import type { Kf8Book, Kf8TocEntry } from './book';

const ROOT = 'OEBPS';

/** Present a reassembled KF8 book as the files of an EPUB 3 container. */
export function synthesizeEpubFiles(book: Kf8Book): Record<string, Uint8Array> {
  const encoder = new TextEncoder();
  const files: Record<string, Uint8Array> = {
    'META-INF/container.xml': encoder.encode(
      '<?xml version="1.0" encoding="utf-8"?>' +
        '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">' +
        `<rootfiles><rootfile full-path="${ROOT}/content.opf" media-type="application/oebps-package+xml"/></rootfiles>` +
        '</container>',
    ),
    [`${ROOT}/content.opf`]: encoder.encode(packageDocument(book)),
    [`${ROOT}/nav.xhtml`]: encoder.encode(navigationDocument(book)),
  };
  for (const part of book.parts)
    files[`${ROOT}/${part.path}`] = encoder.encode(part.html);
  for (const asset of book.assets) files[`${ROOT}/${asset.path}`] = asset.bytes;
  return files;
}

function packageDocument(book: Kf8Book): string {
  const { metadata } = book;
  const items = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...book.parts.map(
      (part, index) =>
        `<item id="part${index}" href="${xml(part.path)}" media-type="application/xhtml+xml"${
          /<svg\b/iu.test(part.html) ? ' properties="svg"' : ''
        }/>`,
    ),
    ...book.assets.map(
      (asset, index) =>
        `<item id="asset${index}" href="${xml(asset.path)}" media-type="${asset.mediaType}"${
          asset.path === book.coverPath ? ' properties="cover-image"' : ''
        }/>`,
    ),
  ];
  const meta = [
    `<dc:identifier id="uid">${xml(metadata.identifier)}</dc:identifier>`,
    `<dc:title>${xml(metadata.title)}</dc:title>`,
    `<dc:language>${xml(metadata.language)}</dc:language>`,
    ...metadata.creators.map(
      (creator) => `<dc:creator>${xml(creator)}</dc:creator>`,
    ),
    metadata.publisher
      ? `<dc:publisher>${xml(metadata.publisher)}</dc:publisher>`
      : '',
    metadata.description
      ? `<dc:description>${xml(metadata.description)}</dc:description>`
      : '',
    metadata.date ? `<dc:date>${xml(metadata.date)}</dc:date>` : '',
    '<meta property="dcterms:modified">2000-01-01T00:00:00Z</meta>',
    metadata.fixedLayout
      ? '<meta property="rendition:layout">pre-paginated</meta>'
      : '',
  ];
  const spine = book.parts.map((_, index) => `<itemref idref="part${index}"/>`);
  const progression = metadata.pageProgression
    ? ` page-progression-direction="${metadata.pageProgression}"`
    : '';
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" prefix="rendition: http://www.idpf.org/vocab/rendition/#">' +
    `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">${meta.join('')}</metadata>` +
    `<manifest>${items.join('')}</manifest>` +
    `<spine${progression}>${spine.join('')}</spine>` +
    '</package>'
  );
}

function navigationDocument(book: Kf8Book): string {
  const list = (entries: readonly Kf8TocEntry[]): string =>
    `<ol>${entries
      .map(
        (entry) =>
          `<li><a href="${xml(entry.href)}">${xml(entry.label)}</a>${
            entry.children.length ? list(entry.children) : ''
          }</li>`,
      )
      .join('')}</ol>`;
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">' +
    `<head><title>${xml(book.metadata.title)}</title></head>` +
    `<body><nav epub:type="toc">${list(book.toc)}</nav></body></html>`
  );
}

function xml(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

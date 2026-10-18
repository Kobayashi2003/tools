import type { PublicationDiagnostic } from '../../publication/model';
import {
  Kf8FormatError,
  latin1,
  parseBase32,
  startsWithAscii,
  u32,
} from './binary';
import { readRawText } from './decompression';
import { readIndexTable } from './index-table';
import { EXTH, exthNumber, exthText, type MobiHeader } from './mobi-header';
import type { PalmDatabase } from './palm-database';
import { readKf8Resource, type Kf8Resource } from './resources';

export interface Kf8Part {
  readonly path: string;
  readonly html: string;
}

export interface Kf8TocEntry {
  readonly label: string;
  readonly href: string;
  readonly children: readonly Kf8TocEntry[];
}

export interface Kf8Metadata {
  readonly title: string;
  readonly creators: readonly string[];
  readonly language: string;
  readonly identifier: string;
  readonly publisher?: string;
  readonly description?: string;
  readonly date?: string;
  readonly fixedLayout: boolean;
  readonly pageProgression?: 'ltr' | 'rtl';
}

/** A KF8 book reassembled into files that an EPUB package can reference. */
export interface Kf8Book {
  readonly metadata: Kf8Metadata;
  readonly parts: readonly Kf8Part[];
  readonly assets: readonly Kf8Resource[];
  readonly coverPath: string | null;
  readonly toc: readonly Kf8TocEntry[];
}

interface Skeleton {
  readonly fragmentCount: number;
  readonly offset: number;
  readonly length: number;
}

interface Fragment {
  readonly insertPosition: number;
  readonly aid: string;
  readonly length: number;
}

interface AssembledPart {
  readonly bytes: Uint8Array;
  /** Range of this part in the original raw-markup coordinates. */
  readonly start: number;
  readonly end: number;
}

const KINDLE_POS = /kindle:pos:fid:([0-9A-Va-v]+):off:([0-9A-Va-v]+)/gu;
const KINDLE_EMBED = /kindle:embed:([0-9A-Va-v]+)(?:\?mime=[^"'\s)]*)?/gu;
const KINDLE_FLOW = /kindle:flow:([0-9A-Va-v]+)(?:\?mime=[^"'\s)]*)?/gu;
const SVG_FLOW_IMAGE =
  /<img\b[^>]*?\bsrc\s*=\s*["']kindle:flow:([0-9A-Va-v]+)\?mime=image\/svg\+xml["'][^>]*>/giu;

export async function readKf8Book(
  database: PalmDatabase,
  header: MobiHeader,
  primary: MobiHeader,
  maxTextBytes: number,
  diagnostics: PublicationDiagnostic[],
): Promise<Kf8Book> {
  const raw = readRawText(database, header, maxTextBytes);
  const flows = splitFlows(database, header, raw);
  const html = flows[0] ?? new Uint8Array();
  const skeletons =
    header.skeleton == null ? [] : readSkeletons(database, header);
  const fragments =
    header.fragment == null ? [] : readFragments(database, header);
  const parts = assembleParts(html, skeletons, fragments);
  const decoder = new TextDecoder(header.encoding);
  const partPath = (index: number) =>
    `Text/part${String(index).padStart(4, '0')}.xhtml`;

  // Resources are shared with the MOBI7 half of a combined file, so their
  // numbering starts at the first header's resource table.
  const firstResource = primary.firstResource ?? header.firstResource;
  const resources = new Map<number, Kf8Resource | null>();
  const resource = async (number: number) => {
    if (!resources.has(number))
      resources.set(
        number,
        firstResource == null
          ? null
          : await readKf8Resource(database, firstResource, number),
      );
    return resources.get(number) ?? null;
  };

  const resolvePosition = (fid: number, offset: number) => {
    const fragment = fragments[fid];
    if (!fragment) return null;
    const position = fragment.insertPosition + offset;
    const index = parts.findIndex(
      (part) => position >= part.start && position < part.end,
    );
    if (index < 0) return null;
    const part = parts[index]!;
    const anchor = anchorBefore(latin1(part.bytes), position - part.start);
    return { index, anchor: anchor ? decodeLatin1(anchor, decoder) : '' };
  };

  let unresolvedLinks = 0;
  const rewrite = async (text: string, fromDirectory: 'Text' | 'Styles') => {
    // Both content directories sit beside Images/, Styles/ and Fonts/.
    const prefix = '../';
    const embeds = new Set<number>();
    for (const match of text.matchAll(KINDLE_EMBED))
      embeds.add(parseBase32(match[1]!));
    for (const number of embeds) await resource(number);
    return text
      .replace(KINDLE_POS, (_, fid: string, offset: string) => {
        const target = resolvePosition(parseBase32(fid), parseBase32(offset));
        if (!target) {
          unresolvedLinks += 1;
          return '#';
        }
        const file = partPath(target.index).slice('Text/'.length);
        const href = fromDirectory === 'Text' ? file : `../Text/${file}`;
        return target.anchor ? `${href}#${target.anchor}` : href;
      })
      .replace(KINDLE_EMBED, (_, number: string) => {
        const found = resources.get(parseBase32(number));
        return found ? `${prefix}${found.path}` : '';
      })
      .replace(KINDLE_FLOW, (_, number: string) => {
        const path = flowPath(parseBase32(number), flows);
        if (!path) return '';
        return fromDirectory === 'Styles' && path.startsWith('Styles/')
          ? path.slice('Styles/'.length)
          : `${prefix}${path}`;
      });
  };

  const assets: Kf8Resource[] = [];
  for (let index = 1; index < flows.length; index += 1) {
    const path = flowPath(index, flows);
    if (!path) continue;
    let text = decoder.decode(flows[index]);
    if (path.endsWith('.css')) text = text.replace(/<!\[CDATA\[|\]\]>/gu, '');
    text = await rewrite(text, path.startsWith('Styles/') ? 'Styles' : 'Text');
    assets.push({
      path,
      mediaType: path.endsWith('.css') ? 'text/css' : 'image/svg+xml',
      bytes: new TextEncoder().encode(text),
    });
  }

  const outputParts: Kf8Part[] = [];
  for (const [index, part] of parts.entries()) {
    let text = decoder.decode(part.bytes);
    // SVG flows that embed images must be inline: an SVG loaded through <img>
    // cannot fetch the images it references.
    text = text.replace(SVG_FLOW_IMAGE, (tag, number: string) => {
      const flow = flows[parseBase32(number)];
      if (!flow) return tag;
      const svg = decoder.decode(flow);
      return /<image\b/iu.test(svg)
        ? svg.replace(/^[\s\S]*?(?=<svg\b)/iu, '')
        : tag;
    });
    text = await rewrite(text, 'Text');
    outputParts.push({ path: partPath(index), html: normalizeMarkup(text) });
  }
  if (unresolvedLinks > 0)
    diagnostics.push({
      code: 'KF8_LINK_UNRESOLVED',
      severity: 'info',
      phase: 'content',
      message: `${unresolvedLinks} internal Kindle links point outside the book text.`,
    });

  const coverOffset =
    exthNumber(header, EXTH.coverOffset) ??
    exthNumber(primary, EXTH.coverOffset);
  const cover = coverOffset == null ? null : await resource(coverOffset + 1);
  for (const value of resources.values())
    if (value && !assets.some((asset) => asset.path === value.path))
      assets.push(value);

  const toc =
    header.ncx == null
      ? []
      : readToc(database, header, resolvePosition, partPath);
  // Kindle books keep the cover outside the text, so the reader would open on
  // the title page. Give the cover its own first page unless the text shows it.
  const coverPage =
    cover && !outputParts[0]?.html.includes(cover.path)
      ? [{ path: 'Text/cover.xhtml', html: coverDocument(cover.path) }]
      : [];
  return {
    metadata: readMetadata(header, primary),
    parts: [...coverPage, ...outputParts],
    assets,
    coverPath: cover?.path ?? null,
    toc: toc.length
      ? toc
      : outputParts.map((part, index) => ({
          label: titleOf(part.html) ?? `Section ${index + 1}`,
          href: part.path,
          children: [],
        })),
  };
}

function splitFlows(
  database: PalmDatabase,
  header: MobiHeader,
  raw: Uint8Array,
): Uint8Array[] {
  if (header.fdst == null) return [raw];
  const record = database.record(header.fdst);
  if (!startsWithAscii(record, 'FDST')) return [raw];
  const count = u32(record, 8);
  const flows: Uint8Array[] = [];
  for (let index = 0; index < count; index += 1) {
    const start = u32(record, 12 + index * 8);
    const end =
      index + 1 < count ? u32(record, 12 + (index + 1) * 8) : raw.length;
    if (start > end || end > raw.length)
      throw new Kf8FormatError('The FDST flow table is out of range.');
    flows.push(raw.subarray(start, end));
  }
  return flows;
}

function flowPath(index: number, flows: readonly Uint8Array[]): string | null {
  const flow = flows[index];
  if (!flow || index === 0) return null;
  const name = String(index).padStart(4, '0');
  return latin1(flow, 0, 512).includes('<svg')
    ? `Images/flow${name}.svg`
    : `Styles/flow${name}.css`;
}

function readSkeletons(database: PalmDatabase, header: MobiHeader): Skeleton[] {
  return readIndexTable(
    database,
    header.skeleton!,
    header.encoding,
  ).entries.map(({ tags }) => {
    const span = tags.get(6);
    const fragmentCount = tags.get(1)?.[0];
    if (!span || span.length < 2 || fragmentCount == null)
      throw new Kf8FormatError('Invalid skeleton index entry.');
    return { fragmentCount, offset: span[0]!, length: span[1]! };
  });
}

function readFragments(database: PalmDatabase, header: MobiHeader): Fragment[] {
  const table = readIndexTable(database, header.fragment!, header.encoding);
  return table.entries.map(({ name, tags }) => {
    const span = tags.get(6);
    const insertPosition = Number.parseInt(name, 10);
    if (!span || span.length < 2 || !Number.isFinite(insertPosition))
      throw new Kf8FormatError('Invalid fragment index entry.');
    // Selector text has the form P-//*[@aid='0'].
    const selector = table.strings.get(tags.get(2)?.[0] ?? -1) ?? '';
    return {
      insertPosition,
      aid: /aid='([^']*)'/u.exec(selector)?.[1] ?? '',
      length: span[1]!,
    };
  });
}

/**
 * Rebuild each part by inserting its fragments into its skeleton. Fragment
 * text follows the skeleton in the raw stream, in insertion order.
 */
function assembleParts(
  html: Uint8Array,
  skeletons: readonly Skeleton[],
  fragments: readonly Fragment[],
): AssembledPart[] {
  if (skeletons.length === 0)
    return [{ bytes: html, start: 0, end: html.length }];
  const parts: AssembledPart[] = [];
  let fragmentIndex = 0;
  for (const skeleton of skeletons) {
    let cursor = skeleton.offset + skeleton.length;
    let part = html.subarray(skeleton.offset, cursor);
    for (let count = 0; count < skeleton.fragmentCount; count += 1) {
      const fragment = fragments[fragmentIndex++];
      if (!fragment) throw new Kf8FormatError('Fragment index ends early.');
      const content = html.subarray(cursor, cursor + fragment.length);
      let insertAt = fragment.insertPosition - skeleton.offset;
      if (insertAt < 0 || insertAt > part.length || insideTag(part, insertAt))
        insertAt =
          afterAidTag(part, fragment.aid) ??
          Math.min(Math.max(0, insertAt), part.length);
      const next = new Uint8Array(part.length + content.length);
      next.set(part.subarray(0, insertAt));
      next.set(content, insertAt);
      next.set(part.subarray(insertAt), insertAt + content.length);
      part = next;
      cursor += fragment.length;
    }
    parts.push({ bytes: part, start: skeleton.offset, end: cursor });
  }
  return parts;
}

function insideTag(bytes: Uint8Array, position: number): boolean {
  const text = latin1(bytes);
  return (
    text.lastIndexOf('<', position - 1) > text.lastIndexOf('>', position - 1)
  );
}

/** Recovery for a corrupt insert position: just after the tag with this aid. */
function afterAidTag(bytes: Uint8Array, aid: string): number | null {
  if (!aid) return null;
  const match = new RegExp(
    `<[^>]*\\said\\s*=\\s*['"]${escapeRegExp(aid)}['"][^>]*>`,
    'iu',
  ).exec(latin1(bytes));
  return match ? match.index + match[0].length : null;
}

/**
 * The id that a Kindle position lands on: the nearest id, name or aid before
 * it. Amazon's `aid` values are exposed as `aid-…` ids by `normalizeMarkup`.
 */
function anchorBefore(text: string, position: number): string {
  let end = position;
  const nextOpen = text.indexOf('<', end);
  const nextClose = text.indexOf('>', end);
  if (
    nextOpen === end ||
    (nextClose >= 0 && (nextOpen < 0 || nextClose < nextOpen))
  )
    end = nextClose + 1;
  for (let close = text.lastIndexOf('>', end - 1); close >= 0;) {
    const open = text.lastIndexOf('<', close);
    if (open < 0) break;
    const tag = text.slice(open, close + 1);
    if (/^<body[\s>]/iu.test(tag)) return '';
    if (!/^<meta\s/iu.test(tag)) {
      const id = /\s(?:id|name)\s*=\s*["']([^"']*)["']/iu.exec(tag)?.[1];
      if (id) return id;
      const aid = /\said\s*=\s*["']([^"']+)["']/iu.exec(tag)?.[1];
      if (aid) return `aid-${aid}`;
    }
    close = text.lastIndexOf('>', open - 1);
  }
  return '';
}

const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** Re-encode as UTF-8 and give every `aid` element a linkable id. */
function normalizeMarkup(text: string): string {
  const body = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  return body
    .replace(/^<\?xml[^>]*\?>/u, '<?xml version="1.0" encoding="utf-8"?>')
    .replace(/(<meta\b[^>]*charset\s*=\s*["']?)[\w-]+/giu, '$1utf-8')
    .replace(
      /<([a-zA-Z][\w:-]*)([^<>]*?\said\s*=\s*["']([^"']+)["'][^<>]*?)(\/?)>/gu,
      (tag, name: string, attributes: string, aid: string, slash: string) =>
        /\sid\s*=/iu.test(attributes)
          ? tag
          : `<${name}${attributes} id="aid-${aid}"${slash}>`,
    );
}

function readToc(
  database: PalmDatabase,
  header: MobiHeader,
  resolve: (
    fid: number,
    offset: number,
  ) => { index: number; anchor: string } | null,
  partPath: (index: number) => string,
): Kf8TocEntry[] {
  const table = readIndexTable(database, header.ncx!, header.encoding);
  const nodes = table.entries.map(({ tags }) => {
    const position = tags.get(6);
    const target =
      position && position.length >= 2
        ? resolve(position[0]!, position[1]!)
        : null;
    const href = target
      ? `${partPath(target.index)}${target.anchor ? `#${target.anchor}` : ''}`
      : null;
    return {
      label: table.strings.get(tags.get(3)?.[0] ?? -1)?.trim() ?? '',
      href,
      parent: tags.get(21)?.[0] ?? -1,
      children: [] as Kf8TocEntry[],
    };
  });
  const roots: Kf8TocEntry[] = [];
  for (const node of nodes) {
    if (!node.href || !node.label) continue;
    const entry = {
      label: node.label,
      href: node.href,
      children: node.children,
    };
    const parent = nodes[node.parent];
    if (parent && parent !== node) parent.children.push(entry);
    else roots.push(entry);
  }
  return roots;
}

function readMetadata(header: MobiHeader, primary: MobiHeader): Kf8Metadata {
  const text = (type: number) => {
    const values = exthText(header, type);
    return values.length ? values : exthText(primary, type);
  };
  const progression = text(EXTH.pageProgression)[0]?.toLowerCase();
  return {
    title: text(EXTH.title)[0] ?? (header.title || primary.title || 'Untitled'),
    creators: text(EXTH.author),
    language: text(EXTH.language)[0] ?? 'und',
    identifier:
      text(EXTH.asin)[0] ??
      text(EXTH.isbn)[0] ??
      `urn:kf8:${header.textLength}`,
    publisher: text(EXTH.publisher)[0],
    description: text(EXTH.description)[0],
    date: text(EXTH.publishingDate)[0],
    fixedLayout: text(EXTH.fixedLayout)[0]?.toLowerCase() === 'true',
    pageProgression:
      progression === 'rtl' || progression === 'ltr' ? progression : undefined,
  };
}

function coverDocument(imagePath: string): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cover</title></head>' +
    `<body><img src="../${imagePath}" alt="Cover"/></body></html>`
  );
}

function titleOf(html: string): string | null {
  return /<title[^>]*>([^<]+)<\/title>/iu.exec(html)?.[1]?.trim() || null;
}

function decodeLatin1(text: string, decoder: TextDecoder): string {
  return decoder.decode(
    Uint8Array.from(text, (character) => character.charCodeAt(0)),
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

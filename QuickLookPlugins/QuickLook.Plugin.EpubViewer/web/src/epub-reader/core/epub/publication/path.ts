import type { FragmentId, PublicationHref, PublicationPath } from './model';

const REMOTE_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const FAKE_ORIGIN = 'https://epub.invalid/';
const FAKE_ORIGIN_URL = new URL(FAKE_ORIGIN);

export interface ResolvedPublicationReference {
  readonly source: string;
  readonly href: PublicationHref;
  readonly path?: PublicationPath;
  readonly fragment?: FragmentId;
  readonly query?: string;
  readonly remote: boolean;
}

export function normalizePublicationPath(input: string): PublicationPath {
  const raw = input.replace(/\\/g, '/').replace(/^\/+/, '');
  const out: string[] = [];

  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(segment);
  }

  return out.join('/');
}

export function dirname(path: PublicationPath): PublicationPath {
  const normalized = normalizePublicationPath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

/**
 * Resolve an EPUB URL reference using WHATWG URL behavior while keeping local
 * references inside the EPUB container root.
 *
 * A WHATWG URL alone is not a sufficient escape check: `../../..` is clamped
 * to the origin root. We therefore validate dot-segment traversal before URL
 * normalization and reject references that attempt to walk above the OCF root.
 */
export function resolvePublicationReference(
  baseFile: PublicationPath,
  source: string,
): ResolvedPublicationReference {
  const trimmed = source.trim();

  if (REMOTE_SCHEME.test(trimmed) || trimmed.startsWith('//')) {
    const absolute = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed;
    const url = new URL(absolute);
    const fragment = url.hash
      ? safeDecodeFragment(url.hash.slice(1))
      : undefined;
    url.hash = '';
    return {
      source,
      href: url.href,
      fragment,
      query: url.search || undefined,
      remote: true,
    };
  }

  assertReferenceStaysInsideContainer(baseFile, trimmed);

  const normalizedBase = normalizePublicationPath(baseFile);
  const base = normalizedBase
    ? new URL(encodePath(normalizedBase), FAKE_ORIGIN)
    : new URL(FAKE_ORIGIN);
  const url = new URL(trimmed || '', base);

  if (url.origin !== FAKE_ORIGIN_URL.origin) {
    throw new Error(`Reference escapes EPUB container: ${source}`);
  }

  const encodedPath = url.pathname.replace(/^\/+/, '');
  const path = normalizePublicationPath(decodePath(encodedPath));
  const fragment = url.hash ? safeDecodeFragment(url.hash.slice(1)) : undefined;

  return {
    source,
    href: `${path}${url.search}${fragment ? `#${fragment}` : ''}`,
    path,
    fragment,
    query: url.search || undefined,
    remote: false,
  };
}

/**
 * Resolve a reference from an XHTML document while honoring its first HTML
 * `<base href>` when present. The base URL is allowed to intentionally point
 * remote (HTML semantics), but local OCF-relative bases remain constrained to
 * the container root.
 */
export function resolvePublicationDocumentReference(
  documentPath: PublicationPath,
  baseHref: string | undefined,
  source: string,
): ResolvedPublicationReference {
  if (!baseHref?.trim())
    return resolvePublicationReference(documentPath, source);

  const documentUrl = new URL(
    encodePath(normalizePublicationPath(documentPath)),
    FAKE_ORIGIN,
  );
  const trimmedBase = baseHref.trim();
  let baseUrl: URL;

  if (REMOTE_SCHEME.test(trimmedBase) || trimmedBase.startsWith('//')) {
    baseUrl = new URL(
      trimmedBase.startsWith('//') ? `https:${trimmedBase}` : trimmedBase,
    );
  } else {
    assertReferenceStaysInsideContainer(documentPath, trimmedBase);
    baseUrl = new URL(trimmedBase, documentUrl);
  }

  const trimmedSource = source.trim();
  let resolvedUrl: URL;
  if (REMOTE_SCHEME.test(trimmedSource) || trimmedSource.startsWith('//')) {
    resolvedUrl = new URL(
      trimmedSource.startsWith('//') ? `https:${trimmedSource}` : trimmedSource,
    );
  } else {
    if (baseUrl.origin === FAKE_ORIGIN_URL.origin) {
      const decodedBasePath = decodePath(baseUrl.pathname.replace(/^\/+/, ''));
      const validationBase = baseUrl.pathname.endsWith('/')
        ? `${normalizePublicationPath(decodedBasePath)}/__epub_base__`
        : normalizePublicationPath(decodedBasePath);
      assertReferenceStaysInsideContainer(validationBase, trimmedSource);
    }
    resolvedUrl = new URL(trimmedSource || '', baseUrl);
  }

  if (resolvedUrl.origin !== FAKE_ORIGIN_URL.origin) {
    const fragment = resolvedUrl.hash
      ? safeDecodeFragment(resolvedUrl.hash.slice(1))
      : undefined;
    resolvedUrl.hash = '';
    return {
      source,
      href: resolvedUrl.href,
      fragment,
      query: resolvedUrl.search || undefined,
      remote: true,
    };
  }

  const path = normalizePublicationPath(
    decodePath(resolvedUrl.pathname.replace(/^\/+/, '')),
  );
  const fragment = resolvedUrl.hash
    ? safeDecodeFragment(resolvedUrl.hash.slice(1))
    : undefined;
  return {
    source,
    href: `${path}${resolvedUrl.search}${fragment ? `#${fragment}` : ''}`,
    path,
    fragment,
    query: resolvedUrl.search || undefined,
    remote: false,
  };
}

/** Resolve one inherited HTML/XML base and retain directory semantics for descendants. */
export function resolvePublicationDocumentBase(
  documentPath: PublicationPath,
  parentBaseHref: string | undefined,
  authoredBaseHref: string,
): string {
  const resolved = resolvePublicationDocumentReference(
    documentPath,
    parentBaseHref,
    authoredBaseHref,
  );
  if (resolved.remote) return resolved.href;
  const path = resolved.path ?? '';
  const directory = authoredBaseHref.trim().endsWith('/');
  const from = dirname(documentPath).split('/').filter(Boolean);
  const to = path.split('/').filter(Boolean);
  let common = 0;
  while (
    common < from.length &&
    common < to.length &&
    from[common] === to[common]
  )
    common += 1;
  const relative =
    `${'../'.repeat(from.length - common)}${to.slice(common).join('/')}` || '.';
  const suffix = directory && !relative.endsWith('/') ? '/' : '';
  return `${relative}${suffix}${resolved.query ?? ''}`;
}

export function splitResolvedHref(href: PublicationHref): {
  readonly resource: PublicationHref;
  readonly fragment?: FragmentId;
} {
  const hash = href.indexOf('#');
  if (hash < 0) return { resource: href };
  return {
    resource: href.slice(0, hash),
    fragment: href.slice(hash + 1) || undefined,
  };
}

/** Path-only portion of a reference, before query/fragment. */
export function referencePathPart(source: string): string {
  const query = source.indexOf('?');
  const hash = source.indexOf('#');
  let end = source.length;
  if (query >= 0) end = Math.min(end, query);
  if (hash >= 0) end = Math.min(end, hash);
  return source.slice(0, end);
}

function assertReferenceStaysInsideContainer(
  baseFile: PublicationPath,
  source: string,
): void {
  const rawPath = referencePathPart(source).replace(/\\/g, '/');
  if (!rawPath) return;

  if (rawPath.startsWith('/')) {
    throw new Error(
      `Root-relative URLs are not valid OCF-relative references: ${source}`,
    );
  }
  const stack = dirname(baseFile).split('/').filter(Boolean);

  for (const rawSegment of rawPath.split('/')) {
    if (!rawSegment) continue;
    const segment = decodeTraversalSegment(rawSegment, source);
    if (segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) {
        throw new Error(`Reference escapes EPUB container root: ${source}`);
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
}

function decodeTraversalSegment(segment: string, source: string): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // Let URL parsing preserve/report malformed percent sequences later. The
    // raw segment is still useful for ordinary traversal checking.
  }

  // Encoded path separators create an ambiguous ZIP-path interpretation after
  // decoding. Reject them rather than allowing a security boundary mismatch.
  if (decoded.includes('/') || decoded.includes('\\')) {
    throw new Error(`Reference contains an encoded path separator: ${source}`);
  }
  return decoded;
}

function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function decodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join('/');
}

function safeDecodeFragment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Validate an actual OCF/ZIP entry name before exposing it as PublicationPath.
 * Unlike URL resolution, archive entry names are already file paths and must
 * never be normalized in a way that aliases `../x` or `/x` to a safe-looking
 * container path.
 */
export function validateArchiveEntryPath(input: string): PublicationPath {
  if (!input || input.startsWith('/') || input.startsWith('\\')) {
    throw new Error(`Invalid absolute/empty OCF entry path: ${input}`);
  }
  if (input.includes('\\'))
    throw new Error(`OCF entry path contains a reverse solidus: ${input}`);
  if (input.includes('\0')) throw new Error('OCF entry path contains U+0000.');

  const segments = input.split('/');
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(
      `OCF entry path contains an empty or dot segment: ${input}`,
    );
  }
  return input;
}

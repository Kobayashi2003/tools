import type { PublicationPath } from '../publication/model';

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  xhtml: 'application/xhtml+xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  ogv: 'video/ogg',
  smil: 'application/smil+xml',
  ncx: 'application/x-dtbncx+xml',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  pdf: 'application/pdf',
});

export function inferMediaType(path: PublicationPath): string | undefined {
  const clean = path.toLowerCase();
  const slash = clean.lastIndexOf('/');
  const dot = clean.lastIndexOf('.');
  if (dot <= slash || dot === clean.length - 1) return undefined;
  return MIME_BY_EXTENSION[clean.slice(dot + 1)];
}

export function isTextualMediaType(mediaType: string): boolean {
  const essence = mediaType.split(';', 1)[0]!.trim().toLowerCase();
  return (
    essence.startsWith('text/') ||
    essence.endsWith('+xml') ||
    essence === 'application/xml' ||
    essence === 'application/xhtml+xml' ||
    essence === 'application/javascript' ||
    essence === 'application/json' ||
    essence === 'application/smil+xml'
  );
}

export function isCssMediaType(mediaType: string): boolean {
  return mediaType.split(';', 1)[0]!.trim().toLowerCase() === 'text/css';
}

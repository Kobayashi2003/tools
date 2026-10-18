import type {
  ContentPresentationHints,
  TextDirection,
  WritingMode,
} from '../../publication';
import { inspectXhtmlIntrinsicViewport } from '../intrinsic-viewport';

export function inspectStaticPresentationHints(
  document: Document,
): ContentPresentationHints {
  const root = document.documentElement;
  const direction = normalizeDirection(root?.getAttribute('dir'));
  const writingMode = normalizeWritingMode(
    inlineStyleValue(root?.getAttribute('style') ?? '', 'writing-mode'),
  );
  const viewport = inspectXhtmlIntrinsicViewport(document);
  return {
    ...(direction ? { direction } : {}),
    ...(writingMode ? { writingMode } : {}),
    ...(viewport ? { viewport } : {}),
  };
}

function inlineStyleValue(style: string, property: string): string | undefined {
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    if (declaration.slice(0, colon).trim().toLowerCase() !== property) continue;
    return declaration
      .slice(colon + 1)
      .trim()
      .replace(/\s*!important\s*$/i, '');
  }
  return undefined;
}

function normalizeDirection(value: string | null): TextDirection | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'ltr' || normalized === 'rtl' || normalized === 'auto'
    ? normalized
    : undefined;
}

function normalizeWritingMode(
  value: string | undefined,
): WritingMode | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'horizontal-tb' ||
    normalized === 'vertical-rl' ||
    normalized === 'vertical-lr'
    ? normalized
    : undefined;
}

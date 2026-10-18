import type { ReaderMark } from '../../features/annotations';
import type { Locator, ReaderPreferences } from '../../epub/publication';
import type { ReadingSessionRecord } from './model';

/** Accepts only the current reading-session shape; development data is not migrated. */
export function parseReadingSessionRecord(
  value: unknown,
): ReadingSessionRecord | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['locator', 'marks', 'updatedAt'], ['preferences'])
  )
    return null;
  const record = value as unknown as Partial<ReadingSessionRecord>;
  if (!isLocator(record.locator)) return null;
  if (record.preferences != null && !isReaderPreferences(record.preferences))
    return null;
  if (!Array.isArray(record.marks) || !record.marks.every(isReaderMark))
    return null;
  if (!isTimestamp(record.updatedAt)) return null;
  return record as ReadingSessionRecord;
}

function isReaderMark(value: unknown): value is ReaderMark {
  if (!isRecord(value)) return false;
  const mark = value as Partial<ReaderMark>;
  if (
    !isNonEmptyString(mark.id) ||
    !isTimestamp(mark.createdAt) ||
    !isTimestamp(mark.updatedAt)
  )
    return false;
  if (mark.label !== undefined && typeof mark.label !== 'string') return false;
  if (
    mark.tags !== undefined &&
    (!Array.isArray(mark.tags) ||
      !mark.tags.every((tag) => typeof tag === 'string'))
  )
    return false;
  const optional = ['label', 'tags'] as const;
  if (mark.kind === 'bookmark') {
    return (
      hasExactKeys(
        value,
        ['id', 'kind', 'locator', 'createdAt', 'updatedAt'],
        optional,
      ) && isLocator(mark.locator)
    );
  }
  if (mark.kind !== 'highlight' && mark.kind !== 'annotation') return false;
  const range = mark.range;
  if (
    !isRecord(range) ||
    !hasExactKeys(range, ['start', 'end']) ||
    !isLocator(range.start) ||
    !isLocator(range.end)
  )
    return false;
  if (
    !isAnnotationColor(mark.color) ||
    !isAnnotationHighlightStyle(mark.highlight)
  )
    return false;
  return mark.kind === 'highlight'
    ? hasExactKeys(
        value,
        ['id', 'kind', 'range', 'color', 'highlight', 'createdAt', 'updatedAt'],
        optional,
      )
    : hasExactKeys(
        value,
        [
          'id',
          'kind',
          'range',
          'body',
          'color',
          'highlight',
          'createdAt',
          'updatedAt',
        ],
        optional,
      ) && typeof value.body === 'string';
}

function isLocator(value: unknown): value is Locator {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['href', 'spineIndex', 'locations'], ['text'])
  )
    return false;
  const locator = value as Partial<Locator>;
  return (
    isNonEmptyString(locator.href) &&
    Number.isInteger(locator.spineIndex) &&
    locator.spineIndex! >= 0 &&
    isLocatorLocations(locator.locations) &&
    (locator.text === undefined || isLocatorText(locator.text))
  );
}

function isLocatorLocations(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasExactKeys(
      value,
      [],
      ['cfi', 'fragment', 'dom', 'progression', 'position'],
    )
  )
    return false;
  if (value.cfi !== undefined && !isNonEmptyString(value.cfi)) return false;
  if (value.fragment !== undefined && typeof value.fragment !== 'string')
    return false;
  if (
    value.progression !== undefined &&
    (!isFiniteNumber(value.progression) ||
      value.progression < 0 ||
      value.progression > 1)
  )
    return false;
  if (
    value.position !== undefined &&
    (!Number.isInteger(value.position) || (value.position as number) < 0)
  )
    return false;
  if (value.dom === undefined) return true;
  return (
    isRecord(value.dom) &&
    hasExactKeys(value.dom, ['path', 'offset', 'nodeType']) &&
    Array.isArray(value.dom.path) &&
    value.dom.path.every(isNonNegativeInteger) &&
    isNonNegativeInteger(value.dom.offset) &&
    isOneOf(value.dom.nodeType, ['text', 'element'])
  );
}

function isLocatorText(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, [], ['before', 'highlight', 'after']) &&
    ['before', 'highlight', 'after'].every(
      (key) => value[key] === undefined || typeof value[key] === 'string',
    )
  );
}

function isReaderPreferences(value: unknown): value is ReaderPreferences {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'flow',
      'spread',
      'pageProgression',
      'fontSizePercent',
      'fontFamily',
      'lineHeight',
      'pageMarginPercent',
      'fixedLayoutFit',
      'fixedLayoutGutter',
      'touchNavigation',
      'pageTurnZonePercent',
      'compatibility',
      'theme',
    ])
  )
    return false;
  return (
    isOneOf(value.flow, ['auto', 'paginated', 'scrolled']) &&
    isOneOf(value.spread, ['auto', 'single', 'double']) &&
    isOneOf(value.pageProgression, ['auto', 'ltr', 'rtl']) &&
    isNumberInRange(value.fontSizePercent, 50, 300) &&
    (value.fontFamily === null || typeof value.fontFamily === 'string') &&
    (value.lineHeight === null || isNumberInRange(value.lineHeight, 0.8, 3)) &&
    isNumberInRange(value.pageMarginPercent, 0, 18) &&
    isOneOf(value.fixedLayoutFit, ['contain', 'width', 'height', 'original']) &&
    isOneOf(value.fixedLayoutGutter, ['none', 'normal']) &&
    isOneOf(value.touchNavigation, ['both', 'tap', 'swipe', 'off']) &&
    isNumberInRange(value.pageTurnZonePercent, 10, 40) &&
    isCompatibilityPreferences(value.compatibility) &&
    isNonEmptyString(value.theme)
  );
}

function isCompatibilityPreferences(value: unknown): boolean {
  const keys = [
    'recoverContainerStructure',
    'selectPreferredRootfile',
    'recoverMalformedXhtml',
    'useLegacyNavigationFallback',
    'normalizeLegacyCss',
    'fitSingleImagePages',
    'deobfuscateIdpfFonts',
  ] as const;
  return (
    isRecord(value) &&
    hasExactKeys(value, keys) &&
    keys.every((key) => typeof value[key] === 'boolean')
  );
}

function isAnnotationColor(value: unknown): boolean {
  return isOneOf(value, [
    'pink',
    'orange',
    'yellow',
    'green',
    'blue',
    'purple',
  ]);
}

function isAnnotationHighlightStyle(value: unknown): boolean {
  return isOneOf(value, ['solid', 'underline', 'strikethrough', 'outline']);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): boolean {
  return isFiniteNumber(value) && value >= minimum && value <= maximum;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

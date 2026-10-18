import type { ReaderUiMessages } from '../model';

export function assertKnownKeys(
  value: object | undefined,
  allowed: object,
  label: string,
): void {
  if (!value) return;
  const known = new Set(Object.keys(allowed));
  for (const key of Object.keys(value)) {
    if (!known.has(key))
      throw new TypeError(`${label} contains an unsupported key: ${key}.`);
  }
}

export function assertFiniteRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `Reader UI ${name} must be between ${minimum} and ${maximum}.`,
    );
  }
}

export function validateMessages(messages: ReaderUiMessages): void {
  for (const [key, value] of Object.entries(messages)) {
    if (typeof value === 'string' && (!value.trim() || value.length > 320)) {
      throw new TypeError(
        `Reader UI message ${key} must be a non-empty string of at most 320 characters.`,
      );
    }
    if (typeof value !== 'string' && typeof value !== 'function') {
      throw new TypeError(
        `Reader UI message ${key} must be a string or message function.`,
      );
    }
  }

  const samples = [
    ...(['clean', 'repaired', 'degraded', 'blocked'] as const).map((status) =>
      messages.compatibilityStatus(status),
    ),
    messages.closePanel('Panel'),
    messages.sectionPosition(1, 2),
    messages.sectionsPosition(1, 2, 3),
    messages.progressThrough(50, 'publication'),
    messages.progressThrough(50, 'section'),
    ...(
      ['archive', 'package', 'preflight', 'resources', 'rendition'] as const
    ).map((phase) => messages.openPhase(phase)),
  ];
  if (
    samples.some(
      (value) =>
        typeof value !== 'string' || !value.trim() || value.length > 320,
    )
  ) {
    throw new TypeError(
      'Reader UI message functions must return non-empty strings of at most 320 characters.',
    );
  }
}

export interface SrcsetCandidate {
  readonly url: string;
  readonly descriptor?: string;
}

/** Tokenize srcset without treating a data URL payload comma as a separator. */
export function parseSrcset(input: string): readonly SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    while (
      cursor < input.length &&
      (isAsciiWhitespace(input[cursor]!) || input[cursor] === ',')
    ) {
      cursor += 1;
    }
    if (cursor >= input.length) break;

    const urlStart = cursor;
    const dataUrl = input.slice(cursor, cursor + 5).toLowerCase() === 'data:';
    if (dataUrl) {
      while (cursor < input.length && !isAsciiWhitespace(input[cursor]!)) {
        cursor += 1;
      }
    } else {
      while (
        cursor < input.length &&
        !isAsciiWhitespace(input[cursor]!) &&
        input[cursor] !== ','
      ) {
        cursor += 1;
      }
    }
    const url = input.slice(urlStart, cursor).replace(/,+$/, '');

    while (cursor < input.length && isAsciiWhitespace(input[cursor]!)) {
      cursor += 1;
    }
    const descriptorStart = cursor;
    while (cursor < input.length && input[cursor] !== ',') cursor += 1;
    const descriptor = input.slice(descriptorStart, cursor).trim() || undefined;
    if (cursor < input.length) cursor += 1;

    if (url) candidates.push({ url, descriptor });
  }

  return candidates;
}

export function formatSrcsetCandidate(candidate: SrcsetCandidate): string {
  return candidate.descriptor
    ? `${candidate.url} ${candidate.descriptor}`
    : candidate.url;
}

function isAsciiWhitespace(char: string): boolean {
  return (
    char === ' ' ||
    char === '\t' ||
    char === '\n' ||
    char === '\r' ||
    char === '\f'
  );
}

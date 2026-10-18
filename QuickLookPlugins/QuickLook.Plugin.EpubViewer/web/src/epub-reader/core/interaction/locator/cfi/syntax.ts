import type {
  CfiPath,
  CfiStep,
  CfiTextAssertion,
  ParsedEpubCfi,
} from '../model';

const ESCAPED = /[\]^,();]|\[/g;

export function escapeCfiAssertion(value: string): string {
  return value.replace(ESCAPED, (character) => `^${character}`);
}

export function unescapeCfiAssertion(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '^' && index + 1 < value.length) {
      result += value[++index]!;
    } else {
      result += character;
    }
  }
  return result;
}

export function parseEpubCfi(value: string): ParsedEpubCfi {
  const trimmed = value.trim();
  if (!trimmed.startsWith('epubcfi(') || !trimmed.endsWith(')')) {
    throw new SyntaxError('EPUB CFI must use epubcfi(...) syntax.');
  }

  const sourceBody = trimmed.slice(8, -1);
  const rangeParts = splitTopLevel(sourceBody, ',');
  if (rangeParts.length !== 1 && rangeParts.length !== 3) {
    throw new SyntaxError('Malformed EPUB CFI range.');
  }
  // A point consumer resolves a range CFI to its range start.
  const body =
    rangeParts.length === 3 ? `${rangeParts[0]}${rangeParts[1]}` : sourceBody;
  const indirection = findUnescaped(body, '!');
  if (indirection < 0) {
    throw new SyntaxError(
      'EPUB CFI does not contain package/content indirection (!).',
    );
  }

  return {
    raw: trimmed,
    packagePath: parseCfiPath(body.slice(0, indirection)),
    contentPath: parseCfiPath(body.slice(indirection + 1)),
  };
}

export function parseCfiPath(value: string): CfiPath {
  const steps: CfiStep[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] !== '/') {
      throw new SyntaxError(`Expected '/' at CFI offset ${cursor}.`);
    }
    cursor += 1;
    const integerStart = cursor;
    while (cursor < value.length && /[0-9]/.test(value[cursor]!)) cursor += 1;
    if (cursor === integerStart) {
      throw new SyntaxError(
        `Missing CFI step integer at offset ${integerStart}.`,
      );
    }

    const rawIndex = value.slice(integerStart, cursor);
    if (rawIndex.length > 1 && rawIndex.startsWith('0')) {
      throw new SyntaxError('CFI integers cannot contain leading zeroes.');
    }
    const index = Number(rawIndex);
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new SyntaxError(`Invalid CFI step ${rawIndex}.`);
    }
    let assertion: string | undefined;
    if (value[cursor] === '[') {
      const bracket = readBracket(value, cursor);
      assertion = unescapeCfiAssertion(
        splitAssertionParameters(bracket.content),
      );
      cursor = bracket.end;
    }
    steps.push({ index, ...(assertion ? { assertion } : {}) });

    if (value[cursor] !== ':') continue;
    cursor += 1;
    const offsetStart = cursor;
    while (cursor < value.length && /[0-9]/.test(value[cursor]!)) cursor += 1;
    if (cursor === offsetStart) {
      throw new SyntaxError('Missing CFI character offset.');
    }
    const rawOffset = value.slice(offsetStart, cursor);
    if (rawOffset.length > 1 && rawOffset.startsWith('0')) {
      throw new SyntaxError('CFI offsets cannot contain leading zeroes.');
    }
    const characterOffset = Number(rawOffset);
    if (!Number.isSafeInteger(characterOffset) || characterOffset < 0) {
      throw new SyntaxError('Invalid CFI character offset.');
    }

    let textAssertion: CfiTextAssertion | undefined;
    let sideBias: CfiPath['sideBias'];
    if (value[cursor] === '[') {
      const terminal = readBracket(value, cursor);
      ({ textAssertion, sideBias } = parseTerminalAssertion(terminal.content));
      cursor = terminal.end;
    }
    if (cursor !== value.length) {
      throw new SyntaxError(
        `Unsupported terminating CFI syntax at offset ${cursor}.`,
      );
    }
    return {
      steps,
      characterOffset,
      ...(textAssertion ? { textAssertion } : {}),
      ...(sideBias ? { sideBias } : {}),
    };
  }

  if (steps.length === 0) throw new SyntaxError('CFI path cannot be empty.');
  return { steps };
}

export function serializeCfiPath(path: CfiPath): string {
  if (path.steps.length === 0) {
    throw new Error('Cannot serialize an empty CFI path.');
  }

  const structural = path.steps
    .map((step) => {
      if (!Number.isSafeInteger(step.index) || step.index < 0) {
        throw new RangeError(
          'CFI step indices must be non-negative safe integers.',
        );
      }
      return `/${step.index}${step.assertion ? `[${escapeCfiAssertion(step.assertion)}]` : ''}`;
    })
    .join('');
  if (path.characterOffset == null) return structural;
  if (!Number.isSafeInteger(path.characterOffset) || path.characterOffset < 0) {
    throw new RangeError(
      'CFI character offset must be a non-negative safe integer.',
    );
  }
  return `${structural}:${path.characterOffset}${serializeTerminalAssertion(
    path.textAssertion,
    path.sideBias,
  )}`;
}

export function stripCfiAssertions(value: string): string {
  let result = '';
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '^' && depth > 0) {
      index += 1;
      continue;
    }
    if (character === '[') {
      depth += 1;
      continue;
    }
    if (character === ']') {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) result += character;
  }
  return result;
}

function readBracket(
  value: string,
  start: number,
): { content: string; end: number } {
  let content = '';
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '^') {
      if (index + 1 >= value.length) {
        throw new SyntaxError('Dangling CFI escape character.');
      }
      content += character + value[++index]!;
      continue;
    }
    if (character === ']') return { content, end: index + 1 };
    content += character;
  }
  throw new SyntaxError('Unterminated CFI assertion.');
}

function splitAssertionParameters(value: string): string {
  const separator = findUnescaped(value, ';');
  return separator < 0 ? value : value.slice(0, separator);
}

function parseTerminalAssertion(value: string): {
  textAssertion?: CfiTextAssertion;
  sideBias?: CfiPath['sideBias'];
} {
  const semicolon = findUnescaped(value, ';');
  const textPart = semicolon < 0 ? value : value.slice(0, semicolon);
  const parameters = semicolon < 0 ? '' : value.slice(semicolon + 1);
  const commaParts = splitTopLevel(textPart, ',');
  if (commaParts.length > 2) {
    throw new SyntaxError('Malformed CFI text location assertion.');
  }

  const before = commaParts[0]
    ? unescapeCfiAssertion(commaParts[0])
    : undefined;
  const after = commaParts[1] ? unescapeCfiAssertion(commaParts[1]) : undefined;
  let sideBias: CfiPath['sideBias'];
  for (const parameter of parameters.split(';')) {
    if (parameter === 's=b') sideBias = 'before';
    else if (parameter === 's=a') sideBias = 'after';
  }

  return {
    ...(before || after
      ? {
          textAssertion: {
            ...(before ? { before } : {}),
            ...(after ? { after } : {}),
          },
        }
      : {}),
    ...(sideBias ? { sideBias } : {}),
  };
}

function serializeTerminalAssertion(
  assertion: CfiTextAssertion | undefined,
  sideBias: CfiPath['sideBias'],
): string {
  if (!assertion && !sideBias) return '';
  const before = assertion?.before ? escapeCfiAssertion(assertion.before) : '';
  const after = assertion?.after ? escapeCfiAssertion(assertion.after) : '';
  const text = after ? `${before},${after}` : before;
  const side = sideBias ? `;s=${sideBias === 'before' ? 'b' : 'a'}` : '';
  return `[${text}${side}]`;
}

function findUnescaped(value: string, needle: string): number {
  let bracketDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '^') {
      index += 1;
      continue;
    }
    if (character === '[') bracketDepth += 1;
    else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === needle && bracketDepth === 0) return index;
  }
  return -1;
}

function splitTopLevel(value: string, delimiter: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (character === '^') {
      index += 1;
      continue;
    }
    if (character === '[') bracketDepth += 1;
    else if (character === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (character === delimiter && bracketDepth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

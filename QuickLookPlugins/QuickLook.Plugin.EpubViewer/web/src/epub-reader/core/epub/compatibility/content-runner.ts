import type {
  ContentPresentationHints,
  PublicationDiagnostic,
  PublicationPath,
  SpineItem,
} from '../publication';
import {
  compatibilityModuleFailureDiagnostic,
  type CompatibilityModuleDescriptor,
  type CompatibilityRuleResult,
  type CompatibilityRunResult,
} from './model';

export type ContentDocumentParseMode = 'xml' | 'html-recovery';

export interface ContentPresentationCandidate {
  readonly writingMode?: ContentPresentationHints['writingMode'];
  readonly direction?: ContentPresentationHints['direction'];
  readonly writingModeSource?: 'standard' | 'legacy';
}

export interface ContentDocumentCompatibilityContext {
  readonly path: PublicationPath;
  readonly spineItem: SpineItem;
  readonly mediaType: string;
  /** Authored source after bounded resource reading and text decoding. */
  readonly authoredSource: string;
  /** Present only when the fixed standards-first parser rejected the source. */
  readonly standardParseError?: unknown;
  /** Optional result of fixed CSS-cascade inspection; modules may interpret legacy aliases. */
  readonly presentationCandidate?: ContentPresentationCandidate;
}

export interface ContentDocumentCompatibilityState {
  readonly source: string;
  readonly parseMode: ContentDocumentParseMode;
  readonly hints: ContentPresentationHints;
}

export interface ContentDocumentCompatibilityRule extends CompatibilityModuleDescriptor {
  readonly family: 'content-document';
  readonly stage: 'content-document.processing';
  apply(
    context: ContentDocumentCompatibilityContext,
    state: ContentDocumentCompatibilityState,
  ):
    | CompatibilityRuleResult<ContentDocumentCompatibilityState>
    | Promise<CompatibilityRuleResult<ContentDocumentCompatibilityState>>;
}

export async function runContentDocumentCompatibility(
  rules: readonly ContentDocumentCompatibilityRule[],
  context: ContentDocumentCompatibilityContext,
  initial: ContentDocumentCompatibilityState,
): Promise<CompatibilityRunResult<ContentDocumentCompatibilityState>> {
  let value = freezeState(initial);
  const diagnostics: PublicationDiagnostic[] = [];
  for (const rule of rules) {
    try {
      const result = await rule.apply(context, value);
      value = freezeState(validateState(result.value));
      diagnostics.push(...(result.diagnostics ?? []));
    } catch (error) {
      diagnostics.push(
        compatibilityModuleFailureDiagnostic(rule, error, {
          path: context.path,
          spineIndex: context.spineItem.index,
        }),
      );
    }
  }
  return Object.freeze({ value, diagnostics: Object.freeze(diagnostics) });
}

function validateState(
  state: ContentDocumentCompatibilityState,
): ContentDocumentCompatibilityState {
  if (typeof state.source !== 'string')
    throw new TypeError('Compatible content source must be a string.');
  if (state.parseMode !== 'xml' && state.parseMode !== 'html-recovery') {
    throw new TypeError(
      'Compatible content parse mode must be xml or html-recovery.',
    );
  }
  const { writingMode, direction, viewport } = state.hints;
  if (
    writingMode &&
    !['horizontal-tb', 'vertical-rl', 'vertical-lr'].includes(writingMode)
  ) {
    throw new TypeError(`Unsupported compatible writing mode: ${writingMode}.`);
  }
  if (direction && !['ltr', 'rtl', 'auto'].includes(direction)) {
    throw new TypeError(`Unsupported compatible text direction: ${direction}.`);
  }
  if (
    viewport &&
    (!Number.isFinite(viewport.width) ||
      viewport.width <= 0 ||
      !Number.isFinite(viewport.height) ||
      viewport.height <= 0)
  ) {
    throw new RangeError(
      'Compatible intrinsic viewport must use positive finite dimensions.',
    );
  }
  return state;
}

function freezeState(
  state: ContentDocumentCompatibilityState,
): ContentDocumentCompatibilityState {
  const hints = Object.freeze({
    ...state.hints,
    ...(state.hints.viewport
      ? { viewport: Object.freeze({ ...state.hints.viewport }) }
      : {}),
    ...(state.hints.page
      ? { page: Object.freeze({ ...state.hints.page }) }
      : {}),
  });
  return Object.freeze({ ...state, hints });
}

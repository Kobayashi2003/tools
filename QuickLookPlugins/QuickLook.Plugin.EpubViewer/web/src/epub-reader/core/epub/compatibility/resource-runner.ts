import type {
  Publication,
  PublicationDiagnostic,
  PublicationPath,
} from '../publication';
import {
  compatibilityModuleFailureDiagnostic,
  type CompatibilityModuleDescriptor,
  type CompatibilityRuleResult,
  type CompatibilityRunResult,
} from './model';

interface ResourceCompatibilityRuleBase extends CompatibilityModuleDescriptor {
  readonly family: 'resource';
}

export interface BinaryResourceCompatibilityContext {
  readonly publication: Publication;
  readonly path: PublicationPath;
  readonly mediaType: string;
  readonly encryptionAlgorithm?: string;
  /** Fixed upper bound checked again after every module transformation. */
  readonly maxOutputBytes: number;
}

export interface BinaryResourceCompatibilityRule extends ResourceCompatibilityRuleBase {
  readonly stage: 'resource.binary';
  applies(context: BinaryResourceCompatibilityContext): boolean;
  apply(
    context: BinaryResourceCompatibilityContext,
    bytes: Uint8Array,
  ):
    | CompatibilityRuleResult<Uint8Array>
    | Promise<CompatibilityRuleResult<Uint8Array>>;
}

export interface StylesheetCompatibilityContext {
  readonly publication: Publication;
  readonly path: PublicationPath;
  readonly maxOutputCharacters: number;
}

export interface StylesheetResourceCompatibilityRule extends ResourceCompatibilityRuleBase {
  readonly stage: 'resource.stylesheet';
  apply(
    context: StylesheetCompatibilityContext,
    css: string,
  ): CompatibilityRuleResult<string> | Promise<CompatibilityRuleResult<string>>;
}

export interface InlineStyleCompatibilityContext {
  readonly publication: Publication;
  readonly documentPath: PublicationPath;
  readonly maxOutputCharacters: number;
}

export interface InlineStyleResourceCompatibilityRule extends ResourceCompatibilityRuleBase {
  readonly stage: 'resource.inline-style';
  apply(
    context: InlineStyleCompatibilityContext,
    css: string,
  ): CompatibilityRuleResult<string> | Promise<CompatibilityRuleResult<string>>;
}

export type ResourceCompatibilityRule =
  | BinaryResourceCompatibilityRule
  | StylesheetResourceCompatibilityRule
  | InlineStyleResourceCompatibilityRule;

export async function runBinaryResourceCompatibility(
  rules: readonly ResourceCompatibilityRule[],
  context: BinaryResourceCompatibilityContext,
  initial: Uint8Array,
): Promise<
  CompatibilityRunResult<Uint8Array> & {
    readonly matchedModuleIds: readonly string[];
    readonly appliedModuleIds: readonly string[];
  }
> {
  let value = initial.slice();
  const diagnostics: PublicationDiagnostic[] = [];
  const appliedModuleIds: string[] = [];
  const matchedModuleIds: string[] = [];
  for (const rule of rules) {
    if (rule.stage !== 'resource.binary') continue;
    try {
      if (!rule.applies(context)) continue;
      matchedModuleIds.push(rule.id);
      const result = await rule.apply(context, value.slice());
      if (!(result.value instanceof Uint8Array))
        throw new TypeError(
          'Compatible binary resource must remain a Uint8Array.',
        );
      if (result.value.byteLength > context.maxOutputBytes) {
        throw new RangeError(
          `Compatible binary resource exceeds the ${context.maxOutputBytes}-byte output limit.`,
        );
      }
      value = result.value.slice();
      appliedModuleIds.push(rule.id);
      diagnostics.push(...(result.diagnostics ?? []));
    } catch (error) {
      diagnostics.push(
        compatibilityModuleFailureDiagnostic(rule, error, {
          path: context.path,
        }),
      );
    }
  }
  return Object.freeze({
    value: value.slice(),
    diagnostics: Object.freeze([...diagnostics]),
    matchedModuleIds: Object.freeze(matchedModuleIds),
    appliedModuleIds: Object.freeze(appliedModuleIds),
  });
}

export async function runStylesheetResourceCompatibility(
  rules: readonly ResourceCompatibilityRule[],
  context: StylesheetCompatibilityContext,
  initial: string,
): Promise<CompatibilityRunResult<string>> {
  let value = initial;
  const diagnostics: PublicationDiagnostic[] = [];
  for (const rule of rules) {
    if (rule.stage !== 'resource.stylesheet') continue;
    try {
      const result = await rule.apply(context, value);
      value = validateTextResult(result.value, context.maxOutputCharacters);
      diagnostics.push(...(result.diagnostics ?? []));
    } catch (error) {
      diagnostics.push(
        compatibilityModuleFailureDiagnostic(rule, error, {
          path: context.path,
        }),
      );
    }
  }
  return frozen(value, diagnostics);
}

export async function runInlineStyleResourceCompatibility(
  rules: readonly ResourceCompatibilityRule[],
  context: InlineStyleCompatibilityContext,
  initial: string,
): Promise<CompatibilityRunResult<string>> {
  let value = initial;
  const diagnostics: PublicationDiagnostic[] = [];
  for (const rule of rules) {
    if (rule.stage !== 'resource.inline-style') continue;
    try {
      const result = await rule.apply(context, value);
      value = validateTextResult(result.value, context.maxOutputCharacters);
      diagnostics.push(...(result.diagnostics ?? []));
    } catch (error) {
      diagnostics.push(
        compatibilityModuleFailureDiagnostic(rule, error, {
          path: context.documentPath,
        }),
      );
    }
  }
  return frozen(value, diagnostics);
}

function validateTextResult(
  value: string,
  maxOutputCharacters: number,
): string {
  if (typeof value !== 'string')
    throw new TypeError('Compatible CSS resource must remain a string.');
  if (value.length > maxOutputCharacters) {
    throw new RangeError(
      `Compatible CSS resource exceeds the ${maxOutputCharacters}-character output limit.`,
    );
  }
  return value;
}

function frozen<T>(
  value: T,
  diagnostics: readonly PublicationDiagnostic[],
): CompatibilityRunResult<T> {
  return Object.freeze({ value, diagnostics: Object.freeze([...diagnostics]) });
}

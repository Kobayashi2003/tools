import type {
  ReaderToolCommand,
  ReaderToolContext,
  ReaderToolModule,
  ReaderToolPlacement,
  ReaderToolRegistry,
} from './model';

const TOOL_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const PLACEMENTS = new Set<ReaderToolPlacement>([
  'navigation',
  'primary',
  'secondary',
]);
const COMMANDS = new Set<ReaderToolCommand>(['open-search', 'open-help']);

/** Validates and freezes one deterministic set of peer Reader tools. */
export function createReaderToolRegistry(
  modules: readonly ReaderToolModule[],
): ReaderToolRegistry {
  const byId = new Map<string, ReaderToolModule>();
  const byCommand = new Map<ReaderToolCommand, ReaderToolModule>();
  const validated = modules.map((candidate, index) => {
    const label = `Reader tool at index ${index}`;
    if (!candidate || typeof candidate !== 'object')
      throw new TypeError(`${label} must be an object.`);
    if (typeof candidate.id !== 'string' || !TOOL_ID.test(candidate.id)) {
      throw new TypeError(`${label} must have a lowercase namespaced id.`);
    }
    if (byId.has(candidate.id))
      throw new TypeError(`Duplicate Reader tool id: ${candidate.id}.`);
    for (const key of ['label', 'shortLabel', 'description'] as const) {
      const value = candidate[key];
      if (typeof value !== 'string' || !value.trim() || value.length > 160) {
        throw new TypeError(
          `Reader tool ${candidate.id} ${key} must be a non-empty string of at most 160 characters.`,
        );
      }
    }
    if (!PLACEMENTS.has(candidate.placement)) {
      throw new TypeError(
        `Reader tool ${candidate.id} has an unsupported placement: ${String(candidate.placement)}.`,
      );
    }
    if (
      candidate.ariaKeyShortcuts != null &&
      (typeof candidate.ariaKeyShortcuts !== 'string' ||
        !candidate.ariaKeyShortcuts.trim())
    ) {
      throw new TypeError(
        `Reader tool ${candidate.id} ariaKeyShortcuts must be a non-empty string.`,
      );
    }
    if (candidate.command != null) {
      if (!COMMANDS.has(candidate.command)) {
        throw new TypeError(
          `Reader tool ${candidate.id} has an unsupported command: ${String(candidate.command)}.`,
        );
      }
      if (byCommand.has(candidate.command)) {
        throw new TypeError(
          `Reader command ${candidate.command} is already owned by another tool.`,
        );
      }
    }
    if (
      candidate.isAvailable != null &&
      typeof candidate.isAvailable !== 'function'
    ) {
      throw new TypeError(
        `Reader tool ${candidate.id} isAvailable must be a function.`,
      );
    }
    if (
      typeof candidate.renderIcon !== 'function' ||
      typeof candidate.render !== 'function'
    ) {
      throw new TypeError(
        `Reader tool ${candidate.id} must provide renderIcon and render functions.`,
      );
    }
    const module = Object.freeze({ ...candidate });
    byId.set(module.id, module);
    if (module.command) byCommand.set(module.command, module);
    return module;
  });
  const frozenModules = Object.freeze(validated);

  return Object.freeze({
    modules: frozenModules,
    resolve: (id: string) => byId.get(id),
    forCommand: (command: ReaderToolCommand) => byCommand.get(command),
    available: (context: Pick<ReaderToolContext, 'reader'>) =>
      Object.freeze(
        frozenModules.filter((module) => {
          try {
            return module.isAvailable?.(context) ?? true;
          } catch {
            // A faulty optional contribution must not take down the Reader Shell.
            return false;
          }
        }),
      ),
  });
}

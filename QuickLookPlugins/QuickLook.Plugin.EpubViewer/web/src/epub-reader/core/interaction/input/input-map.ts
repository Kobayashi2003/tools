import {
  assertExtensionId,
  DuplicateExtensionIdError,
} from '../../extension/model';
import type {
  ReaderCommand,
  ReaderInputBinding,
  ReaderInputMap,
  ReaderInputMapDescription,
  ReaderInputResolution,
  ReaderInputSignal,
  ReaderInputState,
  ReaderShortcutGroup,
} from './model';
import { cloneAndFreezePlainData } from '../../shared/immutable';

export class ReaderInputBindingRegistry {
  private readonly bindings = new Map<string, ReaderInputBinding>();

  constructor(bindings: readonly ReaderInputBinding[] = []) {
    for (const binding of bindings) this.register(binding);
  }

  register(binding: ReaderInputBinding): () => void {
    validateBinding(binding);
    if (this.bindings.has(binding.id))
      throw new DuplicateExtensionIdError(binding.id);
    const stored = freezeBinding(binding);
    this.bindings.set(stored.id, stored);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.bindings.get(stored.id) === stored)
        this.bindings.delete(stored.id);
    };
  }

  createMap(): ReaderInputMap {
    const ordered = [...this.bindings.values()]
      .map((binding, index) => ({ binding, index }))
      .sort(
        (a, b) =>
          (b.binding.priority ?? 0) - (a.binding.priority ?? 0) ||
          a.index - b.index,
      )
      .map((entry) => entry.binding);
    const description = describeBindings(ordered);
    return Object.freeze({
      description,
      resolve(
        signal: ReaderInputSignal,
        state: ReaderInputState,
      ): ReaderInputResolution {
        const failures: { bindingId: string; error: unknown }[] = [];
        for (const binding of ordered) {
          if (!binding.kinds.includes(signal.kind)) continue;
          try {
            const command = binding.map(
              Object.freeze({ ...signal }),
              Object.freeze({ ...state }),
            );
            if (!command) continue;
            assertCommand(command, signal.kind);
            return Object.freeze({
              command: Object.freeze({ ...command }),
              failures: Object.freeze(failures),
            });
          } catch (error) {
            failures.push(Object.freeze({ bindingId: binding.id, error }));
          }
        }
        return Object.freeze({
          command: null,
          failures: Object.freeze(failures),
        });
      },
    });
  }
}

function validateBinding(binding: ReaderInputBinding): void {
  assertExtensionId(binding.id, 'Reader input binding id');
  if (!Number.isFinite(binding.priority ?? 0))
    throw new TypeError(
      `Reader input binding ${binding.id} priority must be finite.`,
    );
  if (
    !binding.kinds.length ||
    binding.kinds.some(
      (kind) => !['keyboard', 'wheel', 'page-click', 'swipe'].includes(kind),
    )
  ) {
    throw new TypeError(
      `Reader input binding ${binding.id} must declare supported input kinds.`,
    );
  }
  if (typeof binding.map !== 'function')
    throw new TypeError(
      `Reader input binding ${binding.id} must provide map().`,
    );
  if ((binding.shortcuts?.length ?? 0) > 16)
    throw new RangeError(
      `Reader input binding ${binding.id} declares too many shortcut groups.`,
    );
  for (const group of binding.shortcuts ?? []) {
    if (
      !group.label.trim() ||
      group.label.length > 64 ||
      group.items.length > 32
    )
      throw new TypeError(
        `Reader input binding ${binding.id} has an invalid shortcut group.`,
      );
    for (const item of group.items) {
      if (
        !item.action.trim() ||
        item.action.length > 120 ||
        !item.keys.length ||
        item.keys.length > 8 ||
        item.keys.some((key) => !key.trim() || key.length > 32)
      ) {
        throw new TypeError(
          `Reader input binding ${binding.id} has invalid shortcut help metadata.`,
        );
      }
    }
  }
}

function freezeBinding(binding: ReaderInputBinding): ReaderInputBinding {
  return Object.freeze({
    ...binding,
    kinds: Object.freeze([...new Set(binding.kinds)]),
    shortcuts: binding.shortcuts
      ? freezeShortcutGroups(binding.shortcuts)
      : undefined,
  });
}

function describeBindings(
  bindings: readonly ReaderInputBinding[],
): ReaderInputMapDescription {
  const groups = new Map<
    string,
    { label: string; items: ReaderShortcutGroup['items'][number][] }
  >();
  for (const binding of bindings) {
    for (const group of binding.shortcuts ?? []) {
      const target = groups.get(group.label) ?? {
        label: group.label,
        items: [],
      };
      target.items.push(...group.items);
      groups.set(group.label, target);
    }
  }
  return cloneAndFreezePlainData({
    bindingIds: bindings.map((binding) => binding.id),
    shortcutGroups: [...groups.values()].map((group) => ({
      label: group.label,
      items: group.items.map((item) => ({
        ...item,
        keys: [...item.keys],
      })),
    })),
  });
}

function freezeShortcutGroups(
  groups: readonly ReaderShortcutGroup[],
): readonly ReaderShortcutGroup[] {
  return Object.freeze(
    groups.map((group) =>
      Object.freeze({
        label: group.label,
        items: Object.freeze(
          group.items.map((item) =>
            Object.freeze({ ...item, keys: Object.freeze([...item.keys]) }),
          ),
        ),
      }),
    ),
  );
}

function assertCommand(
  command: ReaderCommand,
  kind: ReaderInputSignal['kind'],
): void {
  const allowedSources =
    kind === 'page-click'
      ? ['click-zone', 'center-tap']
      : [kind === 'keyboard' ? 'keyboard' : kind];
  if (!allowedSources.includes(command.source))
    throw new TypeError(
      `Reader input command source ${command.source} does not match ${kind}.`,
    );
  if (
    command.type === 'navigate' &&
    command.direction !== 'forward' &&
    command.direction !== 'backward'
  )
    throw new TypeError('Reader navigation command direction is invalid.');
  if (
    command.type === 'font-step' &&
    command.delta !== 1 &&
    command.delta !== -1
  )
    throw new TypeError('Reader font-step command delta is invalid.');
  if (
    ![
      'navigate',
      'open-search',
      'open-help',
      'toggle-chrome',
      'escape',
      'history-back',
      'history-forward',
      'font-step',
    ].includes(command.type)
  ) {
    throw new TypeError(
      `Unsupported reader command type: ${(command as { type?: unknown }).type}.`,
    );
  }
}

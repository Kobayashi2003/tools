import {
  ExtensionDependencyUnavailableError,
  RequiredExtensionStartError,
  orderExtensions,
  type OrderedExtension,
} from './model';

export type Cleanup = () => void;

/**
 * Deterministic ownership scope for listeners, timers, resources and pending
 * work. Disposing aborts work first and then releases resources in reverse
 * acquisition order.
 */
export class LifecycleScope {
  private readonly controller = new AbortController();
  private readonly cleanups: Cleanup[] = [];
  private disposedValue = false;

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get disposed(): boolean {
    return this.disposedValue;
  }

  add(cleanup: Cleanup): Cleanup {
    if (this.disposedValue) {
      runCleanup(cleanup);
      return noop;
    }
    let active = true;
    const wrapped = () => {
      if (!active) return;
      active = false;
      cleanup();
    };
    this.cleanups.push(wrapped);
    return wrapped;
  }

  listen(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): Cleanup {
    target.addEventListener(type, listener, options);
    return this.add(() => target.removeEventListener(type, listener, options));
  }

  dispose(reason = 'Lifecycle disposed.'): void {
    if (this.disposedValue) return;
    this.disposedValue = true;
    this.controller.abort(createLifecycleAbortError(reason));

    for (let index = this.cleanups.length - 1; index >= 0; index -= 1) {
      runCleanup(this.cleanups[index]!);
    }
    this.cleanups.length = 0;
  }
}

/**
 * Internal startup primitive for publication-scoped Features. EPUB
 * compatibility uses phase-specific registries and runners instead.
 */
export interface LifecycleModule<TContext> extends OrderedExtension {
  start(
    context: TContext,
    scope: LifecycleScope,
  ): void | Cleanup | Promise<void | Cleanup>;
}

export interface ExtensionStartFailure {
  readonly extensionId: string;
  readonly kind: 'dependency-unavailable' | 'start-failed';
  readonly error: unknown;
}

export interface ExtensionLifecycleOptions {
  readonly onOptionalFailure?: (failure: ExtensionStartFailure) => void;
}

export class ActiveExtensionLifecycle {
  readonly startedIds: readonly string[];
  readonly failures: readonly ExtensionStartFailure[];

  constructor(
    startedIds: readonly string[],
    failures: readonly ExtensionStartFailure[],
    private readonly scope: LifecycleScope,
  ) {
    this.startedIds = Object.freeze([...startedIds]);
    this.failures = Object.freeze([...failures]);
  }

  get signal(): AbortSignal {
    return this.scope.signal;
  }

  get disposed(): boolean {
    return this.scope.disposed;
  }

  dispose(reason = 'Extension lifecycle disposed.'): void {
    this.scope.dispose(reason);
  }
}

export async function startLifecycleModules<TContext>(
  modules: readonly LifecycleModule<TContext>[],
  context: TContext,
  options: ExtensionLifecycleOptions = {},
): Promise<ActiveExtensionLifecycle> {
  const ordered = orderExtensions(modules);
  const registeredIds = new Set(modules.map((module) => module.id));
  const unavailableIds = new Set<string>();
  const failures: ExtensionStartFailure[] = [];
  const startedIds: string[] = [];
  const rootScope = new LifecycleScope();

  for (const module of ordered) {
    const unavailableDependencies = (module.dependencies ?? []).filter(
      (dependencyId) =>
        !registeredIds.has(dependencyId) || unavailableIds.has(dependencyId),
    );
    if (unavailableDependencies.length > 0) {
      const error = new ExtensionDependencyUnavailableError(
        module.id,
        Object.freeze(unavailableDependencies),
      );
      const failure: ExtensionStartFailure = {
        extensionId: module.id,
        kind: 'dependency-unavailable',
        error,
      };
      failures.push(failure);
      unavailableIds.add(module.id);
      if ((module.failureMode ?? 'required') === 'optional') {
        reportOptionalFailure(options, failure);
        continue;
      }
      rootScope.dispose(`Required extension ${module.id} could not start.`);
      throw new RequiredExtensionStartError(module.id, error);
    }

    const moduleScope = new LifecycleScope();
    try {
      const cleanup = await module.start(context, moduleScope);
      if (cleanup) moduleScope.add(cleanup);
      rootScope.add(() =>
        moduleScope.dispose(`Extension ${module.id} disposed.`),
      );
      startedIds.push(module.id);
    } catch (error) {
      moduleScope.dispose(`Extension ${module.id} startup failed.`);
      const failure: ExtensionStartFailure = {
        extensionId: module.id,
        kind: 'start-failed',
        error,
      };
      failures.push(failure);
      unavailableIds.add(module.id);
      if ((module.failureMode ?? 'required') === 'optional') {
        reportOptionalFailure(options, failure);
        continue;
      }
      rootScope.dispose(`Required extension ${module.id} startup failed.`);
      throw new RequiredExtensionStartError(module.id, error);
    }
  }

  return new ActiveExtensionLifecycle(startedIds, failures, rootScope);
}

function reportOptionalFailure(
  options: ExtensionLifecycleOptions,
  failure: ExtensionStartFailure,
): void {
  try {
    options.onOptionalFailure?.(failure);
  } catch {
    // Failure reporting is observational and cannot change startup semantics.
  }
}

function runCleanup(cleanup: Cleanup): void {
  try {
    cleanup();
  } catch {
    // One faulty cleanup must not leak resources owned by the remaining scopes.
  }
}

function createLifecycleAbortError(message: string): Error {
  try {
    return new DOMException(message, 'AbortError');
  } catch {
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }
}

function noop(): void {}

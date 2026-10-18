import { assertExtensionId } from './model';
import type { Cleanup } from './lifecycle-scope';

export interface CapabilityKey<T> {
  readonly id: string;
  /** Compile-time only: keeps two differently typed keys from being interchangeable. */
  readonly __capabilityType?: (value: T) => T;
}

export interface CapabilityResolver {
  has<T>(key: CapabilityKey<T>): boolean;
  get<T>(key: CapabilityKey<T>): T | undefined;
  require<T>(key: CapabilityKey<T>): T;
}

interface CapabilityEntry<T = unknown> {
  readonly ownerId: string;
  readonly key: CapabilityKey<T>;
  readonly value: T;
}

export class DuplicateCapabilityError extends Error {
  constructor(
    readonly capabilityId: string,
    readonly existingOwnerId: string,
    readonly attemptedOwnerId: string,
  ) {
    super(
      `Capability ${capabilityId} is already provided by ${existingOwnerId}; ${attemptedOwnerId} cannot replace it.`,
    );
    this.name = 'DuplicateCapabilityError';
  }
}

export class MissingCapabilityError extends Error {
  constructor(readonly capabilityId: string) {
    super(`Required capability is unavailable: ${capabilityId}.`);
    this.name = 'MissingCapabilityError';
  }
}

export function defineCapability<T>(id: string): CapabilityKey<T> {
  assertExtensionId(id, 'Capability id');
  return Object.freeze({ id });
}

export class CapabilityRegistry implements CapabilityResolver {
  private readonly entries = new Map<string, CapabilityEntry>();

  get size(): number {
    return this.entries.size;
  }

  register<T>(ownerId: string, key: CapabilityKey<T>, value: T): Cleanup {
    assertExtensionId(ownerId, 'Capability owner id');
    assertExtensionId(key.id, 'Capability id');
    const existing = this.entries.get(key.id);
    if (existing)
      throw new DuplicateCapabilityError(key.id, existing.ownerId, ownerId);

    const entry: CapabilityEntry<T> = { ownerId, key, value };
    this.entries.set(key.id, entry as CapabilityEntry);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      if (this.entries.get(key.id) === entry) this.entries.delete(key.id);
    };
  }

  has<T>(key: CapabilityKey<T>): boolean {
    return this.entries.has(key.id);
  }

  get<T>(key: CapabilityKey<T>): T | undefined {
    return this.entries.get(key.id)?.value as T | undefined;
  }

  require<T>(key: CapabilityKey<T>): T {
    const entry = this.entries.get(key.id);
    if (!entry) throw new MissingCapabilityError(key.id);
    return entry.value as T;
  }

  ownerOf<T>(key: CapabilityKey<T>): string | undefined {
    return this.entries.get(key.id)?.ownerId;
  }

  ids(): readonly string[] {
    return Object.freeze([...this.entries.keys()]);
  }

  clear(): void {
    this.entries.clear();
  }
}

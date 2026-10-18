import type { ObjectUrlFactory } from './model';

export class BrowserObjectUrlFactory implements ObjectUrlFactory {
  create(bytes: Uint8Array, mediaType: string): string {
    return URL.createObjectURL(
      new Blob([copyToArrayBuffer(bytes)], { type: mediaType }),
    );
  }

  revoke(url: string): void {
    URL.revokeObjectURL(url);
  }
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Owns every object URL created for one opened publication. A renderer session
 * can dispose the whole store deterministically instead of leaking Blob URLs.
 */
export class ObjectUrlStore {
  private readonly urls = new Map<string, string>();
  private disposed = false;

  constructor(private readonly factory: ObjectUrlFactory) {}

  getOrCreate(key: string, bytes: Uint8Array, mediaType: string): string {
    this.assertAlive();
    const existing = this.urls.get(key);
    if (existing) return existing;
    const url = this.factory.create(bytes, mediaType);
    this.urls.set(key, url);
    return url;
  }

  has(key: string): boolean {
    return this.urls.has(key);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const url of this.urls.values()) this.factory.revoke(url);
    this.urls.clear();
  }

  get size(): number {
    return this.urls.size;
  }

  private assertAlive(): void {
    if (this.disposed) throw new Error('ObjectUrlStore has been disposed.');
  }
}

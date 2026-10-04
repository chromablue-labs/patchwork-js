export class Emitter<T extends Record<string, unknown>> {
  private listeners = new Map<keyof T, Set<(payload: T[keyof T]) => void>>();

  on<K extends keyof T>(event: K, fn: (payload: T[K]) => void): () => void {
    let bucket = this.listeners.get(event);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(event, bucket);
    }
    bucket.add(fn as (payload: T[keyof T]) => void);
    return () => this.off(event, fn);
  }

  off<K extends keyof T>(event: K, fn: (payload: T[K]) => void): void {
    this.listeners.get(event)?.delete(fn as (payload: T[keyof T]) => void);
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    const bucket = this.listeners.get(event);
    if (!bucket) return;
    for (const fn of bucket) fn(payload);
  }

  listenerCount(event: keyof T): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  clear(): void {
    this.listeners.clear();
  }
}

/** Bounded, clone-on-read cache for public scan metadata, never vault material. */
export function createSnapshotReadCache<T>(options: {
  ttlMs: number;
  now?: () => number;
  cacheable?: (value: T) => boolean;
}) {
  const now = options.now ?? (() => performance.now());
  let generation = 0;
  let entry: { key: string; value: T; expiresAt: number } | undefined;
  const pending = new Map<string, Promise<T>>();

  return {
    invalidate(): void {
      generation += 1;
      entry = undefined;
      pending.clear();
    },
    async read(key: string, load: () => Promise<T>): Promise<T> {
      if (entry?.key === key && now() < entry.expiresAt) return structuredClone(entry.value);
      const currentGeneration = generation;
      let task = pending.get(key);
      if (!task) {
        task = Promise.resolve().then(load).then(value => {
          if (generation === currentGeneration && (options.cacheable?.(value) ?? true)) {
            entry = { key, value: structuredClone(value), expiresAt: now() + options.ttlMs };
          }
          return value;
        });
        pending.set(key, task);
      }
      try {
        return structuredClone(await task);
      } finally {
        if (pending.get(key) === task) pending.delete(key);
      }
    },
  };
}

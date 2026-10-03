/**
 * Browser storage, or `null` where refused (private windows, blocked data, sandboxes). Never
 * throws.
 */
export function readStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** A device-local choice the whole app reads as one value. */
export type StoredPreference<T> = {
  read(): T;
  subscribe(listener: () => void): () => void;
  write(value: T): void;
};

/**
 * A choice kept between visits, also held in memory so it is honoured for the session if storage
 * refuses it. Readers are notified of every change. `parse` gets `null` for nothing stored or
 * anything it throws on.
 */
export function createStoredPreference<T>({
  key,
  parse,
  serialize = String,
}: {
  key: string;
  parse: (stored: string | null) => T;
  serialize?: (value: T) => string;
}): StoredPreference<T> {
  let current: { value: T } | undefined;
  const listeners = new Set<() => void>();
  const readKept = (): T => {
    try {
      return parse(readStorage()?.getItem(key) ?? null);
    } catch {
      return parse(null);
    }
  };

  return {
    read() {
      current ??= { value: readKept() };
      return current.value;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    write(value) {
      current = { value };
      try {
        readStorage()?.setItem(key, serialize(value));
      } catch {
        // Still honoured for the session.
      }
      for (const listener of listeners) listener();
    },
  };
}

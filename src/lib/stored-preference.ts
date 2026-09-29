/**
 * Browser storage, or `null` where the browser refuses it: a private window, blocked site data, the
 * sandboxes this page may be viewed in. Reading it must never be what stops the app rendering.
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
 * A choice kept between visits.
 *
 * The value is held in memory as well as in storage, so a choice storage will not keep is still
 * honoured for the session, and reading it is the same value every time. Every reader is told of a
 * change at once, whether or not storage took it: a rider who cannot keep a choice still made it.
 * `parse` is handed `null` for nothing stored, and for anything it throws on.
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
        // Honoured for the session all the same; nothing here is a claim.
      }
      for (const listener of listeners) listener();
    },
  };
}

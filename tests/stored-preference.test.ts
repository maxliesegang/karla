import assert from "node:assert/strict";
import test from "node:test";

let isStorageBlocked = false;
const values = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  value: {
    get localStorage() {
      if (isStorageBlocked) throw new Error("SecurityError");
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
      };
    },
  },
});

const { createStoredPreference } = await import("../src/lib/stored-preference.ts");

const numberPreference = (key: string) =>
  createStoredPreference<number>({
    key,
    parse: (stored) => {
      const parsed = JSON.parse(stored ?? "1");
      if (typeof parsed !== "number") throw new Error("not a number");
      return parsed;
    },
  });

test("a kept choice is read back on the next visit", () => {
  values.set("kept", "5");
  assert.equal(numberPreference("kept").read(), 5);
});

test("a value that cannot be read is the same as never having chosen", () => {
  values.set("broken", "{");
  assert.equal(numberPreference("broken").read(), 1);
});

test("a choice storage refuses is still honoured for the session, and announced", () => {
  isStorageBlocked = true;
  const preference = numberPreference("blocked");
  let notified = 0;
  const stopListening = preference.subscribe(() => {
    notified += 1;
  });
  assert.equal(preference.read(), 1);
  preference.write(3);
  assert.equal(preference.read(), 3);
  assert.equal(notified, 1);
  assert.equal(values.has("blocked"), false);
  stopListening();
  isStorageBlocked = false;
});

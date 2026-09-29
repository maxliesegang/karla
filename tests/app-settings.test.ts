import assert from "node:assert/strict";
import test from "node:test";

const values = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  value: {
    location: { search: "" },
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  },
});

const {
  DEFAULT_APP_SETTINGS,
  getAppSettingsFromStored,
  readAppSettings,
  subscribeToAppSettings,
  writeAppSettings,
} = await import("../src/lib/app-settings.ts");

test("a rider who has chosen nothing is given the defaults", () => {
  assert.deepEqual(readAppSettings(), DEFAULT_APP_SETTINGS);
  assert.deepEqual(DEFAULT_APP_SETTINGS, {
    landing: "recent-stop",
    isRememberingStops: true,
    isShowingOtherLineRuns: true,
    stackedDepartureLimit: 8,
  });
});

test("a choice is announced to everything reading it, and kept for the next visit", () => {
  let notified = 0;
  const stopListening = subscribeToAppSettings(() => {
    notified += 1;
  });

  const settings = { ...DEFAULT_APP_SETTINGS, landing: "home", stackedDepartureLimit: 12 } as const;
  writeAppSettings(settings);

  assert.equal(notified, 1);
  assert.deepEqual(readAppSettings(), settings);
  assert.deepEqual(JSON.parse(values.get("karla:settings")!), settings);
  stopListening();
});

test("a stored value is read field by field, and an unreadable one is the default", () => {
  assert.deepEqual(
    getAppSettingsFromStored({
      landing: "home",
      isRememberingStops: false,
      isShowingOtherLineRuns: false,
      stackedDepartureLimit: 5,
    }),
    {
      landing: "home",
      isRememberingStops: false,
      isShowingOtherLineRuns: false,
      stackedDepartureLimit: 5,
    },
  );
  // Nothing kept is every default.
  assert.deepEqual(getAppSettingsFromStored(null), DEFAULT_APP_SETTINGS);
  assert.deepEqual(getAppSettingsFromStored("garbage"), DEFAULT_APP_SETTINGS);
  // A half-written store keeps the fields it stated and defaults the rest.
  assert.deepEqual(getAppSettingsFromStored({ landing: "home" }), {
    ...DEFAULT_APP_SETTINGS,
    landing: "home",
  });
  assert.deepEqual(getAppSettingsFromStored({ stackedDepartureLimit: 6 }), DEFAULT_APP_SETTINGS);
  assert.deepEqual(getAppSettingsFromStored({ isShowingOtherLineRuns: false }), {
    ...DEFAULT_APP_SETTINGS,
    isShowingOtherLineRuns: false,
  });
  assert.deepEqual(getAppSettingsFromStored({ isShowingOtherLineTrips: false }), {
    ...DEFAULT_APP_SETTINGS,
    isShowingOtherLineRuns: false,
  });
});

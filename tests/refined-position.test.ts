import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { readRefinedPosition } from "../src/hooks/geolocation.ts";

type Watcher = {
  onFix: PositionCallback;
  onError: PositionErrorCallback;
  options?: PositionOptions;
  isCleared: boolean;
};

function installGeolocation(): Watcher[] {
  const watchers: Watcher[] = [];
  Object.defineProperty(globalThis.navigator, "geolocation", {
    configurable: true,
    value: {
      watchPosition: (
        onFix: PositionCallback,
        onError: PositionErrorCallback,
        options?: PositionOptions,
      ) => {
        watchers.push({ onFix, onError, options, isCleared: false });
        return watchers.length - 1;
      },
      clearWatch: (watchId: number) => {
        const watcher = watchers[watchId];
        if (watcher) watcher.isCleared = true;
      },
    },
  });
  return watchers;
}

const fix = (accuracy: number, latitude = 48.8932) =>
  ({ coords: { latitude, longitude: 8.7008, accuracy }, timestamp: 0 }) as GeolocationPosition;
const positionError = (code: number) =>
  ({ code, PERMISSION_DENIED: 1, TIMEOUT: 3 }) as GeolocationPositionError;

test("a coarse first fix is refined, and a satellite-grade one settles at once", async () => {
  const watchers = installGeolocation();
  const reading = readRefinedPosition();
  const [watcher] = watchers;
  assert.equal(watcher?.options?.enableHighAccuracy, true);

  watcher?.onFix(fix(1_800, 48.9));
  watcher?.onFix(fix(12));

  assert.equal((await reading).accuracy, 12);
  assert.equal(watcher?.isCleared, true);
});

test("without a satellite fix, the best one stands once the refinement window closes", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const watchers = installGeolocation();
    const reading = readRefinedPosition();
    const [watcher] = watchers;
    watcher?.onFix(fix(90));
    watcher?.onFix(fix(140));
    mock.timers.tick(5_000);

    assert.equal((await reading).accuracy, 90);
    assert.equal(watcher?.isCleared, true);
  } finally {
    mock.timers.reset();
  }
});

test("a timeout after a fix keeps the fix; a refusal or no fix rejects", async () => {
  let watchers = installGeolocation();
  let reading = readRefinedPosition();
  watchers[0]?.onFix(fix(200));
  watchers[0]?.onError(positionError(3));
  assert.equal((await reading).accuracy, 200);

  watchers = installGeolocation();
  reading = readRefinedPosition();
  watchers[0]?.onError(positionError(3));
  await assert.rejects(reading, (error: GeolocationPositionError) => error.code === 3);

  watchers = installGeolocation();
  reading = readRefinedPosition();
  watchers[0]?.onFix(fix(200));
  watchers[0]?.onError(positionError(1));
  await assert.rejects(reading, (error: GeolocationPositionError) => error.code === 1);
  assert.equal(watchers[0]?.isCleared, true);
});

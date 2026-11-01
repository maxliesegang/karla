import assert from "node:assert/strict";
import test from "node:test";
import { countAppOpen } from "../src/data/app-opens.ts";
import "./support/render-hook.ts";

test("a visible app start sends an empty request without credentials or a referrer", (t) => {
  t.mock.getter(document, "visibilityState", () => "visible");
  const request = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 204 }),
  );

  countAppOpen("https://example.org/api/");

  assert.deepEqual(request.mock.calls[0]?.arguments, [
    "https://example.org/api/app-open.php",
    {
      method: "POST",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      redirect: "error",
      keepalive: true,
    },
  ]);
  window.dispatchEvent(new Event("hashchange"));
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(request.mock.callCount(), 1);
});

test("a background launch counts once when it first becomes visible", (t) => {
  let visibility: DocumentVisibilityState = "hidden";
  t.mock.getter(document, "visibilityState", () => visibility);
  const request = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 204 }),
  );

  countAppOpen("/api/");
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(request.mock.callCount(), 0);

  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(request.mock.callCount(), 1);
});

test("Do Not Track and Global Privacy Control suppress the request", (t) => {
  t.mock.getter(document, "visibilityState", () => "visible");
  const request = t.mock.method(
    globalThis,
    "fetch",
    async () => new Response(null, { status: 204 }),
  );
  Object.defineProperty(navigator, "globalPrivacyControl", { configurable: true, get: () => true });
  t.after(() => Reflect.deleteProperty(navigator, "globalPrivacyControl"));
  countAppOpen("/api/");
  Reflect.deleteProperty(navigator, "globalPrivacyControl");

  Object.defineProperty(navigator, "doNotTrack", { configurable: true, get: () => "1" });
  t.after(() => Reflect.deleteProperty(navigator, "doNotTrack"));
  countAppOpen("/api/");
  assert.equal(request.mock.callCount(), 0);
});

test("an offline or blocked counter fails silently without retries", async (t) => {
  t.mock.getter(document, "visibilityState", () => "visible");
  const request = t.mock.method(globalThis, "fetch", async () => {
    throw new TypeError("offline");
  });
  countAppOpen("/api/");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(request.mock.callCount(), 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { flush, renderHook } from "./support/render-hook.ts";
import { usePullToRefresh } from "../src/hooks/pull-to-refresh.ts";

type Props = { onRefresh: () => void | Promise<unknown>; readingCount?: number };

function touch(element: Element, type: string, clientY?: number, clientX = 100) {
  const event = new Event(type, { cancelable: true, bubbles: true });
  const touches = clientY === undefined ? [] : [{ clientX, clientY }];
  Object.defineProperty(event, "touches", { value: touches });
  element.dispatchEvent(event);
}

function pull(element: Element, endX = 100) {
  touch(element, "touchstart", 100);
  touch(element, "touchmove", 300, endX);
  touch(element, "touchend");
}

async function renderPull(initial: Props) {
  const list = document.createElement("div");
  const strip = document.createElement("div");
  const hook = await renderHook<Props, { refresh: () => void }>(
    ({ onRefresh, readingCount }) =>
      usePullToRefresh({
        listRef: { current: list },
        indicatorRef: { current: strip },
        onRefresh,
        readingCount,
        isEnabled: true,
      }),
    initial,
  );
  return { hook, list, strip };
}

test("a refresh that returns a promise holds the strip until the promise settles", async () => {
  let answer!: () => void;
  const { list, strip } = await renderPull({
    onRefresh: () => new Promise<void>((resolve) => (answer = resolve)),
  });
  pull(list);
  assert.ok(strip.classList.contains("is-refreshing"));
  await flush();
  assert.ok(strip.classList.contains("is-refreshing"), "unanswered, the strip holds");
  answer();
  await flush();
  assert.ok(!strip.classList.contains("is-refreshing"));
  assert.equal(strip.style.height, "0px");
});

test("a failed refresh settles the strip too", async () => {
  const { list, strip } = await renderPull({ onRefresh: () => Promise.reject(new Error("down")) });
  pull(list);
  await flush();
  assert.ok(!strip.classList.contains("is-refreshing"));
});

test("a refresh without a promise settles when the reading count moves", async () => {
  const onRefresh = () => {};
  const { hook, list, strip } = await renderPull({ onRefresh, readingCount: 1 });
  pull(list);
  await flush();
  assert.ok(strip.classList.contains("is-refreshing"));
  await hook.rerender({ onRefresh, readingCount: 2 });
  assert.ok(!strip.classList.contains("is-refreshing"));
});

test("a refresh asked for without a pull opens the strip and settles the same way", async () => {
  let answer!: () => void;
  const { hook, strip } = await renderPull({
    onRefresh: () => new Promise<void>((resolve) => (answer = resolve)),
  });
  hook.current.refresh();
  assert.ok(strip.classList.contains("is-refreshing"));
  answer();
  await flush();
  assert.ok(!strip.classList.contains("is-refreshing"));
});

test("a sideways drag is a scroll, not a pull", async () => {
  let refreshes = 0;
  const { list, strip } = await renderPull({ onRefresh: () => void refreshes++ });
  pull(list, 400);
  assert.equal(refreshes, 0);
  assert.ok(!strip.classList.contains("is-refreshing"));
});

test("a swipe on a fixed sheet closes the sheet, not refreshes the page", async () => {
  let refreshes = 0;
  const { list } = await renderPull({ onRefresh: () => void refreshes++ });
  const sheet = document.createElement("div");
  sheet.style.position = "fixed";
  const row = sheet.appendChild(document.createElement("button"));
  list.appendChild(sheet);
  // Computed style needs the document.
  document.body.appendChild(list);
  pull(row);
  assert.equal(refreshes, 0);
  pull(list);
  assert.equal(refreshes, 1, "the page itself still pulls");
});

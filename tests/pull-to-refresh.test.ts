import assert from "node:assert/strict";
import test from "node:test";
import {
  getPullDistance,
  isPullTriggered,
  PULL_TO_REFRESH_MAX_PX,
  PULL_TO_REFRESH_TRIGGER_PX,
} from "../src/lib/pull-to-refresh.ts";

test("a pull that has not moved downward follows not at all", () => {
  assert.equal(getPullDistance(0), 0);
  assert.equal(getPullDistance(-24), 0);
});

test("the pull resists: it grows with the drag and never passes its ceiling", () => {
  let previous = 0;
  for (let dragY = 1; dragY <= 600; dragY += 9) {
    const distance = getPullDistance(dragY);
    assert.ok(distance >= previous, `a longer drag never reads shorter, at ${dragY}px`);
    assert.ok(distance <= PULL_TO_REFRESH_MAX_PX, `the ceiling holds, at ${dragY}px`);
    previous = distance;
  }
});

test("the mark sits inside a thumb's reach and no sooner", () => {
  assert.ok(
    getPullDistance(80) >= PULL_TO_REFRESH_TRIGGER_PX,
    "a thumb-length drag reaches the mark",
  );
  assert.ok(getPullDistance(20) < PULL_TO_REFRESH_TRIGGER_PX, "a stray drag does not");
});

test("letting go at the mark asks for the feed again, short of it does not", () => {
  assert.equal(isPullTriggered(PULL_TO_REFRESH_TRIGGER_PX), true);
  assert.equal(isPullTriggered(PULL_TO_REFRESH_TRIGGER_PX - 1), false);
  assert.equal(isPullTriggered(getPullDistance(600)), true, "the capped pull is still a pull");
});

import assert from "node:assert/strict";
import test from "node:test";
import { kvvNetwork } from "../src/networks/kvv/kvv-network.ts";

test("sorts S-Bahn branches directly after their trunk line", () => {
  assert.deepEqual(
    ["S52", "S2", "S12", "S31", "S11", "S1", "S51", "S5", "S32"].sort(kvvNetwork.compareLineIds),
    ["S1", "S11", "S12", "S2", "S31", "S32", "S5", "S51", "S52"],
  );
});

test("continues to sort tram lines numerically before S-Bahn lines", () => {
  assert.deepEqual(["S1", "10", "2", "1"].sort(kvvNetwork.compareLineIds), ["1", "2", "10", "S1"]);
});

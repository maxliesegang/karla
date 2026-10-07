import assert from "node:assert/strict";
import test from "node:test";
import { getZentrumPlanOptionsFromStored } from "../src/lib/zentrum-plan-options.ts";

test("saved plan options use the current names", () => {
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({
      paleLineStyle: "original",
      vehiclePathMode: "ahead",
      unlitLineStyle: "trace",
      travelMeasure: "ride",
      initialView: "nearest",
    }),
    {
      paleLineStyle: "original",
      vehiclePathMode: "ahead",
      unlitLineStyle: "trace",
      travelMeasure: "ride",
      initialView: "nearest",
    },
  );
});

test("plan options saved under earlier names are preserved", () => {
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({ planWays: "ahead", callingLineStyle: "trace" }),
    {
      paleLineStyle: "edge",
      vehiclePathMode: "ahead",
      unlitLineStyle: "trace",
      travelMeasure: "arrival",
      initialView: "plan",
    },
  );
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({
      vehiclePathMode: "off",
      planWays: "ahead",
      unlitLineStyle: "trace",
      callingLineStyle: "dots",
    }),
    {
      paleLineStyle: "edge",
      vehiclePathMode: "off",
      unlitLineStyle: "trace",
      travelMeasure: "arrival",
      initialView: "plan",
    },
  );
});

test("the previous plan option fields migrate to the current names", () => {
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({
      overviewPaths: "ahead",
      destinationTime: "ride",
      openAt: "nearest",
      unlitLineStyle: "trace",
    }),
    {
      paleLineStyle: "edge",
      vehiclePathMode: "ahead",
      travelMeasure: "ride",
      initialView: "nearest",
      unlitLineStyle: "trace",
    },
  );
});

test("current option fields take precedence over legacy fields", () => {
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({
      vehiclePathMode: "off",
      overviewPaths: "ahead",
      travelMeasure: "arrival",
      destinationTime: "ride",
      initialView: "plan",
      openAt: "nearest",
    }),
    {
      paleLineStyle: "edge",
      vehiclePathMode: "off",
      travelMeasure: "arrival",
      initialView: "plan",
      unlitLineStyle: "dots-muted",
    },
  );
});

test("legacy contours use the fine edge and current color choices are preserved", () => {
  assert.equal(getZentrumPlanOptionsFromStored({ paleLineStyle: "outline" }).paleLineStyle, "edge");
  for (const paleLineStyle of ["edge", "original", "tone"]) {
    assert.equal(getZentrumPlanOptionsFromStored({ paleLineStyle }).paleLineStyle, paleLineStyle);
  }
});

test("missing, invalid and retired plan options take their defaults", () => {
  const retiredStyle = { unlitLineStyle: "dashes" };
  for (const stored of [null, "invalid", {}, { vehiclePathMode: true }, retiredStyle]) {
    assert.deepEqual(getZentrumPlanOptionsFromStored(stored), {
      paleLineStyle: "edge",
      vehiclePathMode: "off",
      unlitLineStyle: "dots-muted",
      travelMeasure: "arrival",
      initialView: "plan",
    });
  }
});

test("retired stop selection choices are ignored without losing other options", () => {
  const defaults = getZentrumPlanOptionsFromStored(null);
  for (const stopSelectionStyle of ["underline", "paper", "marker"]) {
    assert.deepEqual(
      getZentrumPlanOptionsFromStored({ stopSelectionStyle, travelMeasure: "ride" }),
      { ...defaults, travelMeasure: "ride" },
    );
  }
});

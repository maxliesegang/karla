import assert from "node:assert/strict";
import test from "node:test";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { parseDepartureBoardResponse } from "../src/data/kvv-efa-parsers.ts";

function boardPayload() {
  return {
    departureList: [
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "0" },
        servingLine: { motType: "4", symbol: "3", number: "3", direction: "Rintheim" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "2" },
        servingLine: { motType: "6", symbol: "SEV", number: "SEV", direction: "Bruchsal" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "5" },
        servingLine: { motType: "0", number: "ICE 106", symbol: "", direction: "Hamburg-Altona" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "9" },
        servingLine: { motType: "7", symbol: "N1912", number: "N1912", direction: "Berlin" },
      },
    ],
    servingLines: {
      lines: [
        { mode: { type: "4", number: "3", diva: { stateless: "kvv:21003:E:H:s26" } } },
        { mode: { type: "7", number: "N1912", diva: { stateless: "kvv:flix:N1912:H:s26" } } },
      ],
    },
  };
}

test("a board keeps the local network and leaves long-distance rail and coaches out", () => {
  const board = parseDepartureBoardResponse(boardPayload(), "7000090");

  assert.deepEqual(
    board.departures.map((departure) => departure.lineId),
    ["3", "SEV"],
  );
});

test("long-distance serving directions are not recorded as directions to go and read", () => {
  const board = parseDepartureBoardResponse(boardPayload(), "7000090");

  assert.deepEqual(board.servingLines, [{ lineId: "3", directionId: "kvv:21003:E:H:s26" }]);
});

test("the departure monitor asks for tram, Stadtbahn and bus only", async () => {
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    departureEndpoint: "https://example.test/XSLT_DM_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ departureList: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.fetchDepartureBoard("7000090");

  const parameters = requestedUrl?.searchParams;
  assert.equal(parameters?.get("includedMeans"), "checkbox");
  assert.equal(parameters?.get("std3_commonMacro"), "dm");
  assert.equal(parameters?.get("std3_inclMOT_1Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_4Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_5Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_0Macro"), null);
});

test("the row cap is sent under both names the endpoint knows", async () => {
  // `limit` is exact where it is sent before the mode macros and ignored where it is sent after
  // them — the same request then answers with the monitor's own forty rows, each one a whole
  // calling sequence on a detailed board. `depSequence` holds in either order, so both are sent.
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    departureEndpoint: "https://example.test/XSLT_DM_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ departureList: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.fetchDepartureBoard("7000090", { limit: 6 });

  assert.equal(requestedUrl?.searchParams.get("depSequence"), "6");
  assert.equal(requestedUrl?.searchParams.get("limit"), "6");

  // The endpoint answers a cap of one with nothing at all, so one is never what it is asked.
  await client.fetchDepartureBoard("7000090", { limit: 1 });
  assert.equal(requestedUrl?.searchParams.get("depSequence"), "2");
});

test("a board asked for named line-directions is not asked for the mode macros as well", async () => {
  // The filter is the narrower statement of the same thing: no other mode can be in the answer.
  // Sending the macros anyway would make the monitor answer in its own form — ignoring the row cap
  // and returning every row's complete calling sequence, which a line's reading fetches per trip.
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    departureEndpoint: "https://example.test/XSLT_DM_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ departureList: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.fetchDepartureBoard("7000090", { lineIds: ["kvv:21012:E:H:s26"] });

  assert.equal(requestedUrl?.searchParams.get("std3_commonMacro"), null);
  assert.equal(requestedUrl?.searchParams.get("includedMeans"), null);
  assert.deepEqual(requestedUrl?.searchParams.getAll("line"), ["kvv:21012:E:H:s26"]);
  // The cap is honoured on this form, so it is the one that decides the board's size.
  assert.equal(requestedUrl?.searchParams.get("limit"), "20");
});

test("a stop names each line-direction it knows under the line's own name", () => {
  // The id is opaque: `kvv:21003:E:H:s26` is nobody's line until the stop says whose it is. That
  // pairing is what lets a line be read at a stop whose few rows have no departure of it.
  const board = parseDepartureBoardResponse(boardPayload(), "7000090");

  assert.deepEqual(board.servingLines, [{ lineId: "3", directionId: "kvv:21003:E:H:s26" }]);
});

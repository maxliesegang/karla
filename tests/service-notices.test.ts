import assert from "node:assert/strict";
import test from "node:test";
import type { ServiceNotice, TransitLine } from "../src/data/transit-types.ts";
import { parseServiceNoticeResponse } from "../src/data/kvv-efa-parsers.ts";
import {
  findNoticePeriodLabel,
  findNoticesForStop,
  findNoticesInNetwork,
  getOrderedNotices,
} from "../src/lib/service-notices.ts";

const createLine = (id: string): TransitLine => ({
  id,
  name: id,
  color: "#000",
  textColor: "#fff",
  destinations: [],
  zentrumStopIds: [],
});

const createNotice = (notice: Partial<ServiceNotice>): ServiceNotice => ({
  id: "1",
  title: "Meldung",
  lineIds: [],
  stopIds: [],
  stopNames: [],
  details: [],
  priority: "normal",
  ...notice,
});

/** The shape the operator answers with, reduced to the fields the parser reads. */
const createResponse = (entries: unknown[]) => ({
  additionalInformation: { travelInformations: { travelInformation: entries } },
});

const publishedEntry = {
  infoID: "100004213_KVV_ICSKVV",
  seqID: "3",
  publish: "1",
  valid: "1",
  deactivated: "false",
  priority: "normal",
  concernedLines: [{ number: "012" }, { number: "S11" }],
  concernedStops: [{ stopID: "7001224", name: "Am Lindscharren" }],
  validityPeriod: [
    {
      itdDateTime_From: {
        itdDate: { year: "2026", month: "7", day: "31" },
        itdTime: { hour: "21", minute: "0" },
      },
      itdDateTime_To: {
        itdDate: { year: "2026", month: "9", day: "11" },
        itdTime: { hour: "3", minute: "59" },
      },
    },
  ],
  infoLink: {
    infoLinkText: "Ettlingen: Umleitung wegen Bauarbeiten",
    infoLinkURL:
      "http://projekte.kvv-efa.de:80/cm/XSLT_CM_SHOWADDINFO_REQUEST?infoID=100004213_KVV_ICSKVV",
    htmlText:
      "<p><strong>Linien:</strong> 12, S11<br />Zeitraum: 31.07. bis 11.09.2026</p>\n" +
      "<p>Wegen Bauarbeiten in der Stra&szlig;e:<br />&bull;&nbsp;&nbsp;Umleitung &uuml;ber " +
      "Bruchhausen &ndash; Ettlingen<br />&bull; Haltestelle entf&#228;llt</p>",
  },
};

test("reads a published notice and leaves the withdrawn ones out", () => {
  const notices = parseServiceNoticeResponse(
    createResponse([
      publishedEntry,
      { ...publishedEntry, infoID: "withdrawn", valid: "0" },
      { ...publishedEntry, infoID: "unpublished", publish: "0" },
      { ...publishedEntry, infoID: "deactivated", deactivated: "true" },
    ]),
  );

  assert.equal(notices.length, 1);
  const [notice] = notices;
  assert.equal(notice.id, "100004213_KVV_ICSKVV@3");
  assert.equal(notice.title, "Ettlingen: Umleitung wegen Bauarbeiten");
  // The operator pads its own line numbers; a departure board does not.
  assert.deepEqual(notice.lineNumbers, ["12", "S11"]);
  assert.deepEqual(notice.concernedStops, [{ providerId: "7001224", name: "Am Lindscharren" }]);
  // The operator's page is closed to the public, so the full wording is taken from the reading
  // itself: its rich text becomes the paragraphs it was written in, and nothing else.
  assert.deepEqual(notice.details, [
    "Linien: 12, S11",
    "Zeitraum: 31.07. bis 11.09.2026",
    "Wegen Bauarbeiten in der Straße:",
    "• Umleitung über Bruchhausen – Ettlingen",
    "• Haltestelle entfällt",
  ]);
  assert.equal(notice.validFrom, "2026-07-31T19:00:00.000Z");
  assert.equal(notice.validUntil, "2026-09-11T01:59:00.000Z");
});

test("a notice reaches the line it names, whatever spelling it names it in", () => {
  const notices = [
    createNotice({ id: "padded", lineIds: ["12"] }),
    createNotice({ id: "family", lineIds: ["S11"] }),
    createNotice({ id: "cased", lineIds: ["104S"] }),
    createNotice({ id: "elsewhere", lineIds: ["185"] }),
  ];
  const lines = [createLine("12"), createLine("S11"), createLine("104s")];

  assert.deepEqual(
    findNoticesInNetwork(notices, lines, []).map((notice) => notice.id),
    ["padded", "family", "cased"],
  );
  assert.deepEqual(findNoticesInNetwork(notices, [createLine("S1")], []), []);
});

test("a view with room for one row gets the notice about the stop the rider is standing at", () => {
  const notices = [
    createNotice({ id: "a-line", lineIds: ["2"], validUntil: "2026-08-30T00:00:00.000Z" }),
    createNotice({ id: "this-stop", stopIds: ["tivoli"], validUntil: "2026-12-31T00:00:00.000Z" }),
    createNotice({ id: "urgent", priority: "high", lineIds: ["2"] }),
  ];

  // Without a stop it is the operator's priority and then what ends soonest.
  assert.deepEqual(
    getOrderedNotices(notices).map((notice) => notice.id),
    ["urgent", "a-line", "this-stop"],
  );
  // At a stop, its own closure outranks a replacement service on one of the lines calling there —
  // but never one the operator itself marked urgent.
  assert.deepEqual(
    getOrderedNotices(notices, "tivoli").map((notice) => notice.id),
    ["urgent", "this-stop", "a-line"],
  );
});

test("a stop is concerned by its own closures and by its lines' notices", () => {
  const notices = [
    createNotice({ id: "this-stop", stopIds: ["kronenplatz"] }),
    createNotice({ id: "this-line", lineIds: ["2"] }),
    createNotice({ id: "another-stop", stopIds: ["tivoli"] }),
  ];

  assert.deepEqual(
    findNoticesForStop(notices, "kronenplatz", ["2", "S1"]).map((notice) => notice.id),
    ["this-stop", "this-line"],
  );
});

test("states the part of the period a rider can still act on", () => {
  const now = Date.parse("2026-08-23T12:00:00Z");
  const running = createNotice({
    validFrom: "2026-07-31T19:00:00.000Z",
    validUntil: "2026-09-11T01:59:00.000Z",
  });
  const announced = createNotice({ validFrom: "2026-09-01T04:00:00.000Z" });

  assert.equal(findNoticePeriodLabel(running, now), "bis 11.09.");
  assert.equal(findNoticePeriodLabel(announced, now), "ab 01.09.");
  assert.equal(findNoticePeriodLabel(createNotice({}), now), undefined);
});

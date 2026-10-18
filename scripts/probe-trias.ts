/**
 * Measures what the KVV TRIAS interface offers next to the EFA JSON feed, to decide whether a
 * TRIAS provider is worth a proxy:
 * 1. Transport: can a browser call it directly (CORS, preflight, a `text/plain` body)?
 * 2. Stop identity: which refs name a stop, and does the EFA stop id work as a `StopPointRef`?
 * 3. Run identity: how a StopEvent's `JourneyRef` relates to the EFA row's `tripCode`.
 * 4. Precision: do timetabled and estimated times carry seconds?
 * 5. TripInfoRequest: calls, and whether `IncludePosition` returns a vehicle position.
 *
 *     npm run probe:trias -- [options]
 *
 *       --stop 7000037   EFA stop id to compare at (default Europaplatz)
 *       --rows 20        stop events to ask for (default 20)
 *       --out dir        also write each raw response, the requestor ref redacted
 *
 * The requestor ref comes from `TRIAS_REQUESTOR_REF`, or from `.env.local`. It is a secret: never
 * commit it or print it.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import type { KvvDeparture } from "../src/data/kvv-feed.ts";
import { descendantsNamed, parseXml, type XmlElement } from "../src/data/xml-reader.ts";

const TRIAS_ENDPOINT = "https://projekte.kvv-efa.de/liesegangtrias/trias";
const DEFAULT_STOP_POINT_ID = "7000037";
const DEFAULT_ROWS = 20;
const TIMEOUT_MS = 20_000;
const PROBE_ORIGIN = "https://karla.example";

type Options = { stopPointId: string; rows: number; outDir?: string };

function parseOptions(argv: readonly string[]): Options {
  const read = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const rows = Number(read("rows"));
  return {
    stopPointId: read("stop") ?? DEFAULT_STOP_POINT_ID,
    rows: Number.isInteger(rows) && rows > 0 ? rows : DEFAULT_ROWS,
    outDir: read("out"),
  };
}

function readRequestorRef(): string {
  if (!process.env.TRIAS_REQUESTOR_REF && existsSync(".env.local"))
    process.loadEnvFile(".env.local");
  const ref = process.env.TRIAS_REQUESTOR_REF?.trim();
  if (!ref) {
    console.error("Set TRIAS_REQUESTOR_REF, e.g. in .env.local (git-ignored).");
    process.exit(1);
  }
  return ref;
}

// --- XML: descendant paths over the app's reader. ---

/** Elements along a path of names, each step at any depth below the last. */
const findAll = (node: XmlElement, ...path: string[]): XmlElement[] =>
  path.reduce<XmlElement[]>(
    (level, name) => level.flatMap((parent) => descendantsNamed(parent, name)),
    [node],
  );

const listElementNames = (node: XmlElement): string[] =>
  node.children.flatMap((child) => [child.name, ...listElementNames(child)]);

const find = (node: XmlElement, ...path: string[]): XmlElement | undefined =>
  findAll(node, ...path)[0];
const textOf = (node: XmlElement | undefined, ...path: string[]): string | undefined => {
  const target = node && (path.length ? find(node, ...path) : node);
  const value = target?.text.trim();
  return value ? value : undefined;
};

// --- Requests ---

function envelope(requestorRef: string, payload: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Trias version="1.2" xmlns="http://www.vdv.de/trias" xmlns:siri="http://www.siri.org.uk/siri">
  <ServiceRequest>
    <siri:RequestTimestamp>${new Date().toISOString()}</siri:RequestTimestamp>
    <siri:RequestorRef>${requestorRef}</siri:RequestorRef>
    <RequestPayload>${payload}</RequestPayload>
  </ServiceRequest>
</Trias>`;
}

const escapeXml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const locationRequest = (query: string): string => `
  <LocationInformationRequest>
    <InitialInput><LocationName>${escapeXml(query)}</LocationName></InitialInput>
    <Restrictions><Type>stop</Type><NumberOfResults>5</NumberOfResults></Restrictions>
  </LocationInformationRequest>`;

const stopEventRequest = (stopPointRef: string, rows: number): string => `
  <StopEventRequest>
    <Location>
      <LocationRef><StopPointRef>${escapeXml(stopPointRef)}</StopPointRef></LocationRef>
      <DepArrTime>${new Date().toISOString()}</DepArrTime>
    </Location>
    <Params>
      <NumberOfResults>${rows}</NumberOfResults>
      <StopEventType>departure</StopEventType>
      <IncludePreviousCalls>true</IncludePreviousCalls>
      <IncludeOnwardCalls>true</IncludeOnwardCalls>
      <IncludeRealtimeData>true</IncludeRealtimeData>
    </Params>
  </StopEventRequest>`;

const tripInfoRequest = (journeyRef: string, operatingDayRef: string): string => `
  <TripInfoRequest>
    <JourneyRef>${escapeXml(journeyRef)}</JourneyRef>
    <OperatingDayRef>${escapeXml(operatingDayRef)}</OperatingDayRef>
    <Params>
      <UseTimetabledDataOnly>false</UseTimetabledDataOnly>
      <IncludeCalls>true</IncludeCalls>
      <IncludePosition>true</IncludePosition>
      <IncludeService>true</IncludeService>
    </Params>
  </TripInfoRequest>`;

type TriasResponse = { status: number; elapsedMs: number; body: string; document: XmlElement };

class TriasProbe {
  private responseCount = 0;
  private readonly requestorRef: string;
  private readonly outDir?: string;

  constructor(requestorRef: string, outDir?: string) {
    this.requestorRef = requestorRef;
    this.outDir = outDir;
  }

  async post(label: string, payload: string, contentType = "text/xml"): Promise<TriasResponse> {
    const started = performance.now();
    const response = await fetch(TRIAS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": contentType, Origin: PROBE_ORIGIN },
      body: envelope(this.requestorRef, payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await response.text();
    const elapsedMs = Math.round(performance.now() - started);
    if (this.outDir) {
      this.responseCount += 1;
      const name = `${String(this.responseCount).padStart(2, "0")}-${label}.xml`;
      await writeFile(join(this.outDir, name), body.replaceAll(this.requestorRef, "REDACTED"));
    }
    return { status: response.status, elapsedMs, body, document: parseXml(body) };
  }
}

/** Provider-stated errors, wherever TRIAS or SIRI put them. */
function readErrors(document: XmlElement): string[] {
  return [
    ...findAll(document, "ErrorMessage").map(
      (node) => `${textOf(node, "Code") ?? "?"}: ${textOf(node, "Text") ?? node.text.trim()}`,
    ),
    ...findAll(document, "ErrorCondition").map(
      (node) => textOf(node, "Description") ?? "ErrorCondition",
    ),
  ];
}

// --- Stop events ---

type StopEvent = {
  journeyRef?: string;
  operatingDayRef?: string;
  lineRef?: string;
  directionRef?: string;
  publishedLineName?: string;
  destination?: string;
  stopPointRef?: string;
  bay?: string;
  timetabledTime?: string;
  estimatedTime?: string;
  previousCallCount: number;
  onwardCallCount: number;
  cancelled: boolean;
};

function readStopEvents(document: XmlElement): StopEvent[] {
  return findAll(document, "StopEventResult", "StopEvent").map((event) => {
    const thisCall = find(event, "ThisCall");
    const service = find(event, "Service");
    const departure = thisCall && find(thisCall, "ServiceDeparture");
    return {
      journeyRef: textOf(service, "JourneyRef"),
      operatingDayRef: textOf(service, "OperatingDayRef"),
      lineRef: textOf(service, "LineRef"),
      directionRef: textOf(service, "DirectionRef"),
      publishedLineName: textOf(service, "PublishedLineName", "Text"),
      destination: textOf(service, "DestinationText", "Text"),
      stopPointRef: textOf(thisCall, "StopPointRef"),
      bay: textOf(thisCall, "EstimatedBay", "Text") ?? textOf(thisCall, "PlannedBay", "Text"),
      timetabledTime: textOf(departure, "TimetabledTime"),
      estimatedTime: textOf(departure, "EstimatedTime"),
      previousCallCount: findAll(event, "PreviousCall").length,
      onwardCallCount: findAll(event, "OnwardCall").length,
      cancelled: textOf(service, "Cancelled") === "true",
    };
  });
}

const hasSeconds = (time: string | undefined): boolean =>
  !!time && /T\d\d:\d\d:(?!00)\d\d/.test(time);

const share = (count: number, total: number): string =>
  total ? `${count}/${total} (${Math.round((100 * count) / total)}%)` : "0/0";

/** The EFA row of the same run: `JourneyRef` read as `{servingLine.stateless}:{tripCode}`. */
function matchEfaRow(event: StopEvent, rows: readonly KvvDeparture[]): KvvDeparture | undefined {
  const instant = event.timetabledTime ? Date.parse(event.timetabledTime) : Number.NaN;
  return rows
    .filter(
      (row) =>
        row.tripLocator &&
        `${row.tripLocator.line}:${row.tripLocator.tripCode}` === event.journeyRef,
    )
    .sort(
      (a, b) =>
        Math.abs(Date.parse(a.scheduledDepartureTime) - instant) -
        Math.abs(Date.parse(b.scheduledDepartureTime) - instant),
    )[0];
}

// --- Report ---

const section = (title: string) => console.log(`\n== ${title} ==`);

async function probeTransport(probe: TriasProbe, query: string) {
  section("1. Transport");
  const preflight = await fetch(TRIAS_ENDPOINT, {
    method: "OPTIONS",
    headers: {
      Origin: PROBE_ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  console.log(
    `preflight: HTTP ${preflight.status}, allow-origin ${preflight.headers.get("access-control-allow-origin") ?? "none"}`,
    preflight.ok ? "" : "(browsers reject a non-2xx preflight: only simple requests can work)",
  );
  for (const contentType of ["text/xml", "text/plain"]) {
    const response = await probe.post(
      `transport-${contentType.replace("/", "-")}`,
      locationRequest(query),
      contentType,
    );
    const results = findAll(response.document, "LocationResult").length;
    console.log(
      `POST ${contentType}: HTTP ${response.status}, ${response.body.length} bytes, ${response.elapsedMs} ms, ${results} locations`,
    );
  }
}

async function probeStopIdentity(probe: TriasProbe, query: string): Promise<string[]> {
  section("2. Stop identity");
  const response = await probe.post("location", locationRequest(query));
  const errors = readErrors(response.document);
  if (errors.length) console.log("errors:", errors);
  if (!response.body) console.log("empty response: is the requestor ref active?");
  const refs: string[] = [];
  for (const result of findAll(response.document, "LocationResult")) {
    const ref = textOf(result, "StopPointRef") ?? textOf(result, "StopPlaceRef");
    const name =
      textOf(result, "StopPointName", "Text") ??
      textOf(result, "StopPlaceName", "Text") ??
      textOf(result, "LocationName", "Text");
    const longitude = textOf(result, "Longitude");
    const latitude = textOf(result, "Latitude");
    console.log(`  ${ref ?? "?"}  ${name ?? "?"}  (${latitude ?? "?"}, ${longitude ?? "?"})`);
    if (ref) refs.push(ref);
  }
  return refs;
}

async function probeStopEvents(
  probe: TriasProbe,
  candidates: readonly string[],
  rows: number,
): Promise<StopEvent[]> {
  let best: StopEvent[] = [];
  for (const ref of candidates) {
    const response = await probe.post(
      `stop-events-${ref.replace(/[^\w-]/g, "_")}`,
      stopEventRequest(ref, rows),
    );
    const events = readStopEvents(response.document);
    const errors = readErrors(response.document);
    console.log(
      `StopPointRef ${ref}: ${events.length} events, ${response.elapsedMs} ms`,
      errors.length ? errors : "",
    );
    if (events.length > best.length) best = events;
  }
  return best;
}

function reportEvents(events: readonly StopEvent[], efaRows: readonly KvvDeparture[]) {
  section("3. Run identity (TRIAS stop event ↔ EFA row)");
  let matched = 0;
  for (const event of events) {
    const row = matchEfaRow(event, efaRows);
    if (row) matched += 1;
    const time = event.timetabledTime?.slice(11, 19) ?? "?";
    console.log(
      [
        `  ${(event.publishedLineName ?? "?").padEnd(4)} ${time}`,
        `journey ${event.journeyRef ?? "?"}`,
        `day ${event.operatingDayRef ?? "?"}`,
        `line ${event.lineRef ?? "?"} dir ${event.directionRef ?? "?"}`,
        `stop ${event.stopPointRef ?? "?"} bay ${event.bay ?? "?"}`,
        row
          ? `EFA ${row.scheduledDepartureTime.slice(11, 16)} ${row.platformCode} delay ${row.delayMinutes ?? "?"} min`
          : "no EFA row",
      ].join(" | "),
    );
  }
  console.log(
    `same run on the EFA board, by JourneyRef = line:tripCode: ${share(matched, events.length)}`,
  );

  section("4. Precision and realtime");
  const estimated = events.filter((event) => event.estimatedTime);
  console.log(`with EstimatedTime: ${share(estimated.length, events.length)}`);
  console.log(
    `TimetabledTime with seconds: ${share(events.filter((e) => hasSeconds(e.timetabledTime)).length, events.length)}`,
  );
  console.log(
    `EstimatedTime with seconds: ${share(estimated.filter((e) => hasSeconds(e.estimatedTime)).length, estimated.length)}`,
  );
  console.log(`cancelled: ${events.filter((event) => event.cancelled).length}`);
  for (const event of estimated.slice(0, 8)) {
    const row = matchEfaRow(event, efaRows);
    const triasDelay =
      event.timetabledTime && event.estimatedTime
        ? (Date.parse(event.estimatedTime) - Date.parse(event.timetabledTime)) / 1_000
        : undefined;
    console.log(
      `  ${event.publishedLineName ?? "?"} ${event.timetabledTime?.slice(11, 19)} → ${event.estimatedTime?.slice(11, 19)}`,
      `TRIAS delay ${triasDelay ?? "?"} s, EFA ${row?.delayMinutes ?? "?"} min`,
    );
  }
  const calls = events.map((event) => event.previousCallCount + 1 + event.onwardCallCount);
  console.log(`calls per stop event: ${Math.min(...calls)}–${Math.max(...calls)}`);
}

async function probeTripInfo(probe: TriasProbe, events: readonly StopEvent[]) {
  section("5. TripInfoRequest");
  const event =
    events.find(
      (candidate) => candidate.journeyRef && candidate.operatingDayRef && candidate.estimatedTime,
    ) ?? events.find((candidate) => candidate.journeyRef && candidate.operatingDayRef);
  if (!event?.journeyRef || !event.operatingDayRef) {
    console.log("no stop event with JourneyRef and OperatingDayRef");
    return;
  }
  console.log(`${event.publishedLineName} → ${event.destination}, journey ${event.journeyRef}`);
  const response = await probe.post(
    "trip-info",
    tripInfoRequest(event.journeyRef, event.operatingDayRef),
  );
  const errors = readErrors(response.document);
  if (errors.length) console.log("errors:", errors);
  const previous = findAll(response.document, "TripInfoResult", "PreviousCall").length;
  const onward = findAll(response.document, "TripInfoResult", "OnwardCall").length;
  console.log(
    `HTTP ${response.status}, ${response.elapsedMs} ms, previous calls ${previous}, onward calls ${onward}`,
  );
  const position = find(response.document, "CurrentPosition");
  if (!position) {
    console.log("CurrentPosition: absent");
    return;
  }
  console.log(
    "CurrentPosition:",
    `lat ${textOf(position, "Latitude") ?? "?"}`,
    `lon ${textOf(position, "Longitude") ?? "?"}`,
    `bearing ${textOf(position, "Bearing") ?? "?"}`,
    `progress ${textOf(position, "Percentage") ?? "?"}%`,
    `fields: ${[...new Set(listElementNames(position))].join(", ")}`,
  );
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const requestorRef = readRequestorRef();
  if (options.outDir) await mkdir(options.outDir, { recursive: true });
  const probe = new TriasProbe(requestorRef, options.outDir);

  const efaBoard = await new KvvEfaClient().fetchDepartureBoard(options.stopPointId, {
    limit: options.rows * 2,
  });
  console.log(
    `EFA ${options.stopPointId}: ${efaBoard.stopName}, ${efaBoard.departures.length} rows`,
  );

  await probeTransport(probe, efaBoard.stopName);
  const refs = await probeStopIdentity(probe, efaBoard.stopName);
  const events = await probeStopEvents(
    probe,
    [options.stopPointId, ...refs.slice(0, 2)],
    options.rows,
  );
  if (!events.length) {
    console.log("\nno stop events: nothing further to measure");
    return;
  }
  reportEvents(events, efaBoard.departures);
  await probeTripInfo(probe, events);
}

await main();

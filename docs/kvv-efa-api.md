# KVV EFA API reference

The KVV EFA interfaces relevant to KARLA, as used by the app and as observed on the public
installation. The CC0 GTFS archive, read only offline, is covered in [kvv-gtfs.md](./kvv-gtfs.md).

> [!IMPORTANT]
> An empirical reference, not an official KVV or MENTZ contract. Last verified against the live
> service on **26 August 2026** unless a section says otherwise. Treat undocumented fields as
> changeable, handle missing data defensively, and re-verify before building on a behaviour.

## Base URL and transport

```text
https://projekte.kvv-efa.de/sl3-alone/
```

Endpoints accept `GET` and return JSON with `outputFormat=json`. They mirror the caller's `Origin`
in `Access-Control-Allow-Origin`, so the static site reads them directly. Send only simple headers
(no `User-Agent`, nothing that forces a preflight). Requests are bounded by a 20 s timeout
(`DEFAULT_TIMEOUT_MS`).

### Common parameters

| Parameter | Typical value | Purpose |
| --- | --- | --- |
| `outputFormat` | `json` | JSON rather than the HTML interface. |
| `coordOutputFormat` | `WGS84[DD.ddddd]` | Longitude, latitude in decimal degrees. Omitted, EFA returns its projected `MRCV` grid. |
| `language` | `de`, `en`, `fr` | Language of provider-generated names and messages. |
| `type_*` | `stopID`, `any`, `coord` | Describes the matching `name_*` input. |
| `name_*` | stop id, query, or coordinate | The input value. |
| `mode` | `direct` | Execute without the interactive HTML workflow. |

### JSON irregularities

EFA JSON serialises an XML-shaped model:

- A repeated child is sometimes an object and sometimes an array.
- Empty collections may be `null`, absent, `[]` or `{}`.
- Booleans and numbers are usually strings (`"0"`, `"1"`, `"10"`).
- Time values use several shapes across endpoints, and local wall times carry no UTC offset.
- `parameters` is an array of `{ name, value }` records.
- An HTTP 200 may still carry a warning or unresolved input.

Normalise all of this at the provider boundary.

`parameters` includes `serverTime` (`"2026-08-26T00:10:12"`). Countdowns are anchored to it, not the
device clock. It has no offset, so resolve it as Karlsruhe time. Its seconds are not counted: the
feed's `countdown` is a difference of whole minutes.

## Endpoint overview

| Endpoint | Role | KARLA status |
| --- | --- | --- |
| [`XSLT_DM_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_DM_REQUEST?) | Departures, arrivals, realtime, optional stop sequences | In use |
| [`XML_TRIPSTOPTIMES_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XML_TRIPSTOPTIMES_REQUEST?) | One trip's calls and times | In use for runs on a line and the selected trip |
| [`XML_STOPSEQCOORD_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XML_STOPSEQCOORD_REQUEST?) | A line's whole route plus geometry | In use to seed a line's reading (`fetchLineRoute`) |
| [`XSLT_STOPFINDER_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_STOPFINDER_REQUEST?) | Stop and location search | In use for stops |
| [`XSLT_ADDINFO_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_ADDINFO_REQUEST?) | Published service notices | In use |
| `XML_STOPLIST_REQUEST` | Every stop of a municipality, with locality | Offline, `scripts/refresh-stop-catalog.ts` (`rapidJSON` only) |
| `XML_SERVINGLINES_REQUEST` | Lines serving one stop | Not used: every DM board embeds `servingLines` |
| [`XSLT_COORD_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_COORD_REQUEST?) | Stops inside a bounding box | Verified, not used |
| [`XSLT_TRIP_REQUEST2`](https://projekte.kvv-efa.de/sl3-alone/XSLT_TRIP_REQUEST2?) | Journey planning | Verified, out of scope |
| [`XSLT_SELTT_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_SELTT_REQUEST?) | Timetable or line variant selection | Verified, not used |
| `XSLT_STT_REQUEST`, `XSLT_ROUTE_REQUEST` | Stop timetable, printable route material | Available, not used |
| `XSLT_TTB_REQUEST`, `XSLT_ROP_REQUEST` | Line timetable, route plan (`reqType=lvp`) | Answered an empty `lineByName` for every parameter set tried |
| `XML_GEOOBJECT_REQUEST` | Line geometry | Available, not used |
| `https://projekte.kvv-efa.de/json` | Nominal live vehicle positions | HTTP 400; do not use |

### Arrival discovery and platform coordinates (5 October 2026)

`itdDateTimeDepArr=arr` answers a separate `arrivalList`, with the same run locator fields as
`departureList`. The row's `dateTime` describes arrival; it does not establish a departure.
KARLA uses these rows internally to discover runs ending within a map area.

DM rows provide WGS84 platform coordinates as `x` (longitude) and `y` (latitude).
At `7000007` (Tullastraße/Alter Schlachthof), Gleise 3 and 4 were north of 1a/2a/1b/2b.
S2 called at 3 and 4, and line 5 at 3. A platform code or line name alone does not locate a
boarding place; use the call's coordinates.

The regular Tullastraße board (`7000007`) returned all six Gleise: 1a/2a/1b/2b and 3/4.
The distinct E21/22/E43/44 stop IDs (`7009021`, `7009022`, `7009043`, `7009044`) returned empty
boards in this read; they are not established aliases. In the saved GTFS snapshot, the six regular
platforms share parent `Pde:08212:7`.

Schloss Gottesaue (`7000624`) returned Gleise 1 and 2, about 75 metres apart along the same
Wolfartsweierer Straße–Tullastraße corridor. Both share parent `Pde:08212:624` in that snapshot.
Opposite platforms can stand far apart. Use an observed pair of neighboring calls as evidence that
they serve the same corridor; aggregate neighbor sets alone can join different branches.

## Departure monitor: `XSLT_DM_REQUEST`

```text
XSLT_DM_REQUEST
  ?outputFormat=json
  &type_dm=stopID
  &name_dm=7000089
  &mode=direct
  &useRealtime=1
  &itdDateTimeDepArr=dep
  &limit=20
  &useProxFootSearch=0
  &coordOutputFormat=WGS84[DD.ddddd]
```

| Parameter | Values | Verified behaviour |
| --- | --- | --- |
| `type_dm` | `stopID` | `name_dm` is a provider stop id. |
| `name_dm` | e.g. `7000089` | Stop or stop complex. |
| `useRealtime` | `1` | Ask for predictions; scheduled-only rows still occur. |
| `itdDateTimeDepArr` | `dep`, `arr` | Departures (`departureList`) or arrivals (`arrivalList`, a separate root). |
| `limit` | positive integer | Exact row cap, **only when sent before the mode macros** (see below). |
| `depSequence` | integer ≥ 2 | The same cap, honoured in any position. `1` returns no rows. |
| `useProxFootSearch` | `0` | Off is the default (row-for-row identical when omitted; Europaplatz, Marktplatz, Hauptbahnhof, Mühlburger Tor, 4 September 2026). Sent to pin it: with the mode macros, `1` turns a stop board into a district board (Marktplatz returned rows from Europaplatz, Karlstor, Kronenplatz, Ettlinger Tor, Kapellenstraße and Linkenheimer Tor). Without the macros, `1` is ignored. |
| `line` | `servingLine.stateless`, repeatable | Restrict to those line-directions (below). |

### Requested date and time

`itdDateDayMonthYear=27.08.2026&itdTime=10:00` returns a board from that feed-local time.
`countdown` is then relative to the requested time, not `serverTime`. Future boards with
`useRealtime=1` correctly return no `realDateTime`, no delay and `realtime: "0"`.

### Mode macros

```text
std3_commonMacro=dm
includedMeans=checkbox
std3_inclMOT_0Macro=true   # train
std3_inclMOT_1Macro=true   # S-Bahn / Stadtbahn
std3_inclMOT_4Macro=true   # tram
std3_inclMOT_5Macro=true   # bus
```

Only the macros sent apply (`std3_inclMOT_4Macro=true` alone returned trams only). They filter by
mode *group*, which is coarser than `motType` (Hauptbahnhof `7000090`, 30 August 2026):

| Macro | `motType` values returned |
| --- | --- |
| `std3_inclMOT_0Macro` | `0` Zug (ICE, IC, TGV, rail replacement), `13` R-Bahn, `16` FlixTrain |
| `std3_inclMOT_1Macro` | `1` S-Bahn / Stadtbahn |
| `std3_inclMOT_4Macro` | `4` Straßenbahn |
| `std3_inclMOT_5Macro` | `5` Bus, `6` Ersatzverkehr, `7` Fernbus (`Flixbus (Sondertarif)`) |

Long-distance rail cannot be dropped while keeping regional trains, nor coaches while keeping city
buses. `std3_inclMOT_7Macro=true` alone returned nothing.

The macros also do two costly things:

- **The row cap holds only before them.** `limit` sent after the macros is ignored and the monitor
  returns its own forty rows, silently. `kvv-efa-client.ts` therefore sends `limit` and
  `depSequence` before the macros; the parameter order is load-bearing.
- **They force every row's complete calling sequence**, asked for or not.

A board filtered by `line` needs no macros, since the filter already excludes other modes, so KARLA
sends them only on unfiltered boards. Twenty rows of one line at Augartenstraße:

| Board | Wire | Raw |
| --- | --- | --- |
| unfiltered, macros (what a rider reads) | 92 kB | 654 kB |
| filtered, macros | 88 kB | 676 kB |
| filtered, no macros | **4.1 kB** | 37 kB |

The macros compose with `line`, `depType=stopEvents` and `includeCompleteStopSeq=1`, and also narrow
`servingLines` (unfiltered, Hauptbahnhof stated 83 line-directions, 43 of them Fernbus).

KARLA asks every board for `1`, `4` and `5`, then drops coaches by `motType` when parsing, from rows
and serving directions alike. `limit` is spent before that, so a coach still costs a row.

### Data pools

Every line states a data pool as the first segment of its id (`kvv:22304:E:H:s26`) and in
`liErgRiProj.network`. Measured at Hauptbahnhof (`7000090`) on 5 September 2026 and at `7000039`,
`7000051`, `7000802` and `7001201`: every KVV line answers from `kvv`, while the station's answers
also carry lines from other pools the macros cannot separate:

- `ddb:…` — the DB S-Bahn Rhein-Neckar (S3, S6, S9 toward Mannheim, through to Karlsruhe since
  December 2025), under `motType 1` beside the AVG Stadtbahn;
- `rab:…` — express-train rail replacement (`SEV RE7`), under `motType 6` beside KVV's buses;
- `bus:…` — Flixbus, under `motType 7`, already dropped by mode.

KARLA keeps a line whose pool is `kvv` or unstated and drops other pools, from rows and serving
directions (`kvv-efa-parsers.ts`).

### Line filter: `line`

Repeated `line` parameters with `servingLine.stateless` values restrict the board exactly (unlike
`lineRestriction`). Ids are **per direction** (`kvv:21003:E:H:s26` and `kvv:21003:E:R:s26` are the two
directions of line 3), so a line needs both. Every departure carries its id as `routeDirectionId`.

The filter buys horizon as well as bandwidth: twenty unfiltered rows at a Zentrum post reach
minutes; twenty rows of one line reach hours.

The filter must be sent whole or not at all. A one-direction filter silently omits the other
direction, and since ids are learned from rows, the missing id is never learned. KARLA reads
unfiltered until both directions of every line in the reading are named (`lib/line-observation.ts`).

An unfiltered board's `servingLines.lines[]` names every line-direction known at the stop, including
ones with no row, each with `mode.diva.stateless` and `mode.number` (the id and the line's name).
This is how a line without a row on a busy board is still named. It is schedule metadata: nothing is
rendered from it without a live row.

A line is read in two steps: light filtered boards say which runs exist, then each run under way is
read once from the single-trip endpoint (3.2 kB on the wire) rather than arriving again at every
stop. A run whose nearest row is hours away has not set out and is not read. One round of S4 from
Augartenstraße (56 calling points, 1093 rows):

| Reading | Requests | Raw |
| --- | --- | --- |
| one detailed board per stop | 56 | 34.5 MB |
| rows, then the runs under way | 69 | **2.2 MB** |

The endpoint speaks HTTP/2, so extra requests multiplex over one connection.

### Sizes

Byte counts are decompressed unless a table says wire. Responses gzip about 6–8×.

### Stop sequences

```text
depType=stopEvents
includeCompleteStopSeq=1
```

| Parameters | Result |
| --- | --- |
| Neither | No sequence |
| `depType=stopEvents` only | No sequence in the tested response |
| `includeCompleteStopSeq=1` only | Small or partial sequence |
| Both | Complete `prevStopSeq` and `onwardStopSeq` |

A three-departure sample grew from 37 kB to 88 kB with sequences. KARLA's rules:

- A plain board asks for nothing past its rows (the macros add sequences anyway), and twenty rows is
  the budget: to see further, filter by `line`.
- A stop may make one cached topology read every 30 minutes. Completing sparse directions is a
  reading with its own lifetime, one filtered request for all of them; its held rows show only
  where they are further away than the reading is old.
- A line is read as rows, and its runs as trips, never as a detailed board per stop.

## Single trip: `XML_TRIPSTOPTIMES_REQUEST`

One trip instead of a whole detailed board. The locator comes from a basic DM row;
`RealtimeTripId` alone is not accepted.

| Request parameter | DM field |
| --- | --- |
| `tripCode` | `servingLine.key` |
| `line` | `servingLine.stateless` |
| `stopID` | `stopID` |
| `date` | scheduled `dateTime` as `YYYYMMDD` |
| `time` | scheduled `dateTime` as `HHMM` |

Also send `outputFormat=json`, `coordOutputFormat=WGS84[DD.ddddd]`, `useRealtime=1` and
`tStOTType=ALL|NEXT|PREVIOUS` (`ALL` for a complete ride). The response carries `serverTime`,
`vehicleCallAtStop`, `mode` and `stopSeq`. A 54-call trip was 39.5 kB with `ALL` and 7.8 kB
(9 calls) with `NEXT`; a one-row detailed DM response for it was 62.5 kB.

- The path is `XML_…`; `XSLT_TRIPSTOPTIMES_REQUEST` returns HTTP 400.
- Missing, wrong, `tripId`-only and `RealtimeTripId`-only locators return HTTP 200 with an empty
  `stopSeq`. Validate a non-empty sequence and the echoed `vehicleCallAtStop`.
- Read realtime from each call's `arrValid` / `depValid`, delay and `realtimeStatus`; `mode.realtime`
  stayed `"0"` on trips with valid predictions.
- When both validity flags are `"0"`, retain the scheduled call times without delays. Observed on
  S4 trip 3770 on 5 October 2026; discarding these times leaves scheduled-only runs unplaceable.
- Cancellation appears as `TRIP_CANCELLED` on the calls; `-9999` remains the no-prediction sentinel.
- The DM row stays the stop's departure fact (countdown, platform, destination, hints, notices); the
  trip's sequence is merged into it.
- A locator is provider state, not a URL identity; deep links rediscover it from a live board.

### Event fields

| Field | Meaning and cautions |
| --- | --- |
| `stopID` | Stop id of the actual event; one complex may return several. |
| `nameWO` / `stopName` | Name without / with locality. |
| `countdown` | Minutes from the board's requested time. |
| `dateTime` | Scheduled local time. |
| `realDateTime` | Predicted local time, when supplied. |
| `platform` | Bare platform code, used as identity. |
| `platformName` | Display form, often with the platform word. |
| `pointType` | The operator's word (`Gleis`, `Bstg.`); not inferable from mode. |
| `realtimeStatus` | Stop-event status, including cancellation. |
| `realtimeTripStatus` | Whole-trip state: cancellation, diversion, extra trip. |
| `servingLine` | Line, destination, mode, delay, hints, operational identity. |
| `operator` | Operator code, name, public code. |
| `attrs` | Trip ids and planned accessibility (`RealtimeTripId`, `AVMSTripID`, `PlanLowFloorVehicle`, `PlanWheelChairAccess`). |
| `lineInfos` / `stopInfos` / `tripInfos` | Notices embedded against the line, stop or trip. |
| `prevStopSeq` / `onwardStopSeq` | Detailed calls when requested. |

`servingLine.hints` mixes vehicle facts and operating reasons: `Niederflurwagen`, `Stufenloses
Fahrzeug, WLAN, WC, Klimaanlage`, `Nicht barrierefreies Fahrzeug`, delay explanations. Match the
negation before the positive vocabulary; no hint means unknown, not inaccessible.

`servingLine.trainNum` relates joined workings: on the S8 from Karlsruhe to Freudenstadt/Bondorf
both rows carried `85653`, and the continuing portion also `AVMSTripID 85653-2`. There is no coupling
flag; combine the number with matching line and departure, a shorter route that is a strict prefix,
and agreeing shared schedule times.

Detailed stop references can also carry `gid`, `areaGid`, `pointGid`, `zone`, `niveau` and `coords`.
`pointGid` may distinguish boarding positions more finely than the platform code; it stays a provider
identity.

### Realtime interpretation

1. Scheduled time comes from `dateTime` or the sequence's scheduled fields.
2. The prediction is `realDateTime` when valid.
3. A delay of `-9999` means no prediction.
4. `arrDateTimeSec` in a sequence is scheduled; the delay is separate.
5. Cancellation and diversion override ordinary delay presentation.

`useRealtime=1` is not evidence that every row is realtime.

`servingLine.delay` is truncated where `realDateTime` is not. Over 500 monitored rows at 26 stops
(30 August 2026), `realDateTime` equalled `dateTime + delay` on 368 and ran one minute later on 19,
never earlier; eleven of those had `delay: 0`. Neither field appeared without the other. `countdown`
follows `dateTime + delay`, so no reading agrees with both; KARLA follows the prediction, putting its
countdown a minute above the platform display on about one row in twenty.

### Turnarounds

Nothing joins the run ending at a terminus to the one starting there; `src/lib/line-turnarounds.ts`
infers it. `scripts/probe-turnarounds.ts` polled six termini on the evening of 4 September 2026,
with that Friday's timetable read alongside.

**Published times pin a turn only modulo the headway.** An arrival turning out `g` minutes later
fits the timetable as well as one turning out `g + headway` later with one more vehicle. Line 1 at
midday runs Wolfartsweier Nord → Neureut-Heide in 32.6 min and back in 33.5, turns at Neureut-Heide in
3.9, every 10: the Wolfartsweier Nord layover is 0 min on 7 vehicles or 10 min on 8, and nothing
published tells them apart.

**A published gap of zero** makes the minimal reading impossible, so the real turn is at least one
headway. It is common:

| Terminus | Line | Headway, day / evening | Published turn, day / evening |
| --- | --- | --- | --- |
| Rintheim | 3 | 10 / 20 min | 9 min / 0 |
| Wolfartsweier Nord | 1 | 10 / 20 min | 0 / 7 min |
| Neureut-Heide | 1 | 10 / 20 min | 3 min / 11 min |

**Turns are per line, terminus and service period**: each terminus above has one day turn and a
different evening one.

**Unstarted runs** state `delay: 0` for as long as they are listed, which cannot be told apart from
an unmonitored departure; whether they inherit the arriving vehicle's lateness is untested.

**Platform** held across every observed pair, but every sampled terminus had one platform.

### Parameters that do not filter usefully

- Accessibility options (`imparedOptionsActive=1`, `lowPlatformVhcl=on`, `wheelchair=on`,
  `noSolidStairs=on`, `noEscalators=on`, `noElevators=on`) are echoed as active, but a
  `Nicht barrierefreies Fahrzeug` row was still returned. Read each event's vehicle information.
- `lineRestriction=403`, `maxTimeLoop`, `mergeDep=1`, `equivs=1` and `itdLPxx_depOnly=1` did not
  filter departures; `lineRestriction=403` still returned InterCity and Flixbus at Hauptbahnhof.
- `useAllStops=0` and `1` both returned Europaplatz's surface and underground stops.
- `itdLPxx_template`, `itdLPxx_snippet`, `sessionID`, `requestID` are HTML client plumbing.

No parameter narrows a stop complex to one stop point: `7000037` and `7001004` return the same
Europaplatz rows, street and tunnel, as do Marktplatz's two tunnels. The board is split where it is
read (`src/lib/boarding-places.ts`). Verified 4 September 2026, such a board also:

- **shares one row cap between its places.** Europaplatz at `depSequence=40` answered 30 street and
  10 tunnel rows; Marktplatz 30 Kaiserstraße and 10 Pyramide. `kvv-stop-mappings.ts` raises the cap
  for these stops.
- **lists a vehicle twice where it calls at two places in turn.** Line 4 to Oberreut
  (`de:kvv:00004_:.kvv-21-4-E.5.T0.1054.s26`) appears at `Gleis 3` at 08:58 and `Gleis 5` at 08:59,
  both under stop id `7000037` in its trip sequence. Trams carry no `trainNum`, so
  `keepOneRowPerRun` keeps both, as it should: a rider may stand at either.

## Line route: `XML_STOPSEQCOORD_REQUEST`

The only source for every stop of a line, in order, in one request; elsewhere a route is inferred
from whatever trips are running.

```text
XML_STOPSEQCOORD_REQUEST
  ?outputFormat=json
  &line=kvv:21003:E:R:s26
  &tripCode=35
  &date=20260904
  &time=0900
  &stop=7000089
```

| Request parameter | DM field |
| --- | --- |
| `line` | `servingLine.stateless` |
| `tripCode` | `servingLine.key` |
| `stop` | `stopID` (named `stop` here, not `stopID`) |
| `date` | scheduled `dateTime` as `YYYYMMDD` |
| `time` | scheduled `dateTime` as `HHMM` |

The answer, `stopSeqCoords`, has:

- `params.stopSeq[]` — the run's calls from origin to destination terminus (not from the requested
  stop), each with `ref.id`, `ref.gid`, `place`, `placeID`, `platformName` and `ref.depDateTime`;
- `coords.path` — projected coordinate pairs. `coordListOutputFormat=NONE` does not suppress it.

Line 3 (3 September 2026): `:R:` returned 30 stops, Daxlanden Waidweg → Rintheim, 29.4 kB (6.7 kB of
it a 249-point path); `:H:` 32 stops, 32.2 kB.

- `tripCode` must name a real run at that date and time; otherwise HTTP 200 with an empty `stopSeq`.
- `stop` must be one the run calls at. Line 3 `:R:` from its origin `7000306` returned nothing, from
  `7000089` the whole route; why is not established. Prefer a through stop.
- It answers for one run: a short working returns the short route. Ask at a daytime time, or take
  the union of several runs.
- A stop id can repeat with different `ref.area` / `ref.platform`; deduplicate on `ref.id`.
- It states the route as currently timetabled, diversions included (the tested run was signed
  `Rintheim (Umleitung)`).

## Lines at a stop: `XML_SERVINGLINES_REQUEST`

```text
XML_SERVINGLINES_REQUEST?outputFormat=json&mode=odv&type_sl=stopID&name_sl=7000089
```

Not used: every DM response embeds `servingLines.lines[]` in the same shape (`parseServingLines`).
The endpoint returned 58 line-directions at Hauptbahnhof against the board's 32; the difference is
modes KARLA drops anyway.

Neither source names the direction that only arrives at a terminus: at Hochstetten both state
`kvv:22301:E:R:s26` and `kvv:22311:E:R:s26`, departing directions only. Naming both directions needs a
stop further along the line.

## Stop finder: `XSLT_STOPFINDER_REQUEST`

```text
XSLT_STOPFINDER_REQUEST
  ?outputFormat=json
  &type_sf=any
  &name_sf=Marktplatz
  &anyObjFilter_sf=2
  &coordOutputFormat=WGS84[DD.ddddd]
```

- `anyObjFilter_sf=2` returns stops only. For `Kaiserstr`, unfiltered: 269 results (123 stops, 145
  streets, 1 POI); filtered: 230 stops. Non-stop objects were crowding stops out of a capped answer.
- `locationServerActive=1` made no difference (byte-identical for `Marktplatz` and `Kaiserstr`).
- `type_sf=stop` is a different, nationwide index without `anyType` or `ref.coords` (`Kaiserstr`
  returned 74 stops from Aachen to Ahlbeck). Keep `type_sf=any`.
- Several matches come back as a list in `stopFinder.points`; one comes back as the object
  `stopFinder.points.point`.

`anyType` values: `stop` (used), `singlehouse`, `street`, `poi`, `loc`. Stop results carry
`stateless`, `ref.id`, `ref.gid`, `ref.place`, `ref.coords`, `name`, `mainLoc` and `quality`. Provider
ids stay behind `TransitSource`.

## Published notices: `XSLT_ADDINFO_REQUEST`

```text
XSLT_ADDINFO_REQUEST
  ?outputFormat=json
  &filterDateValid=26.08.2026
  &filterPublicationStatus=current
```

`filterDateValid` takes network-local `DD.MM.YYYY`; without it the whole KVV area is returned. The
date-filtered answer was about 457 kB, so it has its own slow cadence.

Withdrawn records stay in the response. A notice is published only when `publish == "1"`,
`valid == "1"` and `deactivated != "true"`.

| Field | Use |
| --- | --- |
| `infoID` and `seqID` | Together identify a revision. |
| `priority` | Normal or high. |
| `infoLink.infoLinkText` | The operator's title. |
| `infoLink.infoLinkURL` | The operator's notice page. |
| `infoLink.htmlText` | Full HTML body; sanitise if rendered. |
| `infoLink.attachments` | Replacement timetables, diagrams, PDFs. |
| `infoLink.additionalLinks` | Related operator pages. |
| `validityPeriod` | One or more active intervals. |
| `publicationDuration` | Publication window, distinct from validity. |
| `creationTime` | Source creation time. |
| `concernedLines` / `concernedStops` | Affected lines, directions, places and stops. |
| `affectDMRequest` / `affectTripRequest` / `affectTimetable` | What the publisher marked as affected. |

KARLA reduces multiple validity periods to their outer span, which loses gaps. Links in responses
may use `http://host:80/...`; KARLA upgrades them to HTTPS.

Basic DM entries also embed `lineInfos`, `stopInfos` and `tripInfos`. They could attach notices to
exact events, but do not replace the notices view; deduplicate by provider identity if combined.

## Coordinate search: `XSLT_COORD_REQUEST`

```text
XSLT_COORD_REQUEST
  ?outputFormat=json
  &coordOutputFormat=WGS84[DD.DDDDD]
  &boundingBox=
  &boundingBoxLU=8.395:49.000:WGS84[DD.DDDDD]
  &boundingBoxRL=8.405:48.990:WGS84[DD.DDDDD]
  &inclFilter=1
  &type_1=STOP
```

The empty `boundingBox=` is required; without it the corners are ignored. `boundingBoxLU` is the
northwest corner, `boundingBoxRL` the southeast, both `longitude:latitude:format`. Stop pins carry
`id`, `stateless`, `desc`, `locality`, `coords`, `distance`, `STOP_GLOBAL_ID`,
`STOP_NAME_WITH_PLACE`, `STOP_MAJOR_MEANS`, `STOP_MEANS_LIST`, `STOP_MOT_LIST` and
`STOP_TARIFF_ZONES:kvv`. A small Hauptbahnhof box returned six stops in 7 kB. `XML_COORD_REQUEST`
returns the same schema.

Not used: it would send an area derived from the rider's position to KVV, whereas nearby ranking
is local today. If ever added, make it an explicit action and confirm results with a live board.

## Journey planning: `XSLT_TRIP_REQUEST2`

Out of scope; recorded for completeness.

```text
type_origin=stopID
name_origin=7000089
type_destination=stopID
name_destination=7001001
std3_commonMacro=trip
outputFormat=json
coordOutputFormat=WGS84[DD.ddddd]
```

Inputs can be stops, search values, addresses, POIs or coordinates
(`type_origin=coord&name_origin=8.411860:49.009415:WGS84[DD.ddddd]` reverse-geocoded to
Kaiserstraße 12 with nearby stops and walking times).

| Capability | Parameters |
| --- | --- |
| Date and time | `itdDateDayMonthYear`, `itdTime` |
| Depart/arrive by | `itdTripDateTimeDepArr=dep\|arr` |
| Realtime | `useRealtime=1` |
| Fastest / fewest changes / least walking | `routeType=LEASTTIME\|LEASTINTERCHANGE\|LEASTWALKING` |
| Maximum changes | `maxChanges=9\|0\|1\|2` |
| Maximum walking time | `trITMOTvalue100=5\|10\|15\|20\|30` |
| Nearby alternative stops | `useProxFootSearch=on` |
| Via point and dwell | `type_via`, `name_via`, `dwellTimeMinutes` |
| Local transport | `lineRestriction=403` |
| Accessibility | `imparedOptionsActive=1` with `noSolidStairs`, `noEscalators`, `noElevators`, `lowPlatformVhcl`, `wheelchair` |

Form options such as `routeType` and `useProxFootSearch` apply only with `std3_commonMacro=trip`;
mode filtering uses the DM macros with `includedMeans=checkbox`. Other generic options in the schema
(`noCrowded`, `assistance`, `SOSAvail`, …) were partly ignored. An accessibility option constrains
routing; it does not prove a result accessible.

Responses (118–171 kB) contain alternatives, durations, transit and walking legs, scheduled and
realtime times, planned and actual platforms, stop sequences, operator and trip identities, hints,
`path` geometry, `turnInst` walking instructions, and tariff data. The `trips` root is an array for
several alternatives and an object for a single walking result. `command=tripPrev|tripNext|…` relies
on session cookies; a static client should re-request with an adjusted time instead.

## Timetable documents

`XSLT_SELTT_REQUEST?itdLPxx_page=stt|ttb|rop` selects official stop timetables, line timetables and
route plans; `XSLT_STT_REQUEST`, `XSLT_TTB_REQUEST`, `XSLT_ROP_REQUEST` and `XSLT_ROUTE_REQUEST`
produce them. A selection such as
`XSLT_SELTT_REQUEST?outputFormat=json&type_seltt=stopID&name_seltt=7000089&lineReqType=8` returned
line variants with `number`, `destination`, `description`, `operator`, `timetablePeriod`,
validity, stateless identity and `isSTT` / `isTTB` / `isROP`, including future construction variants
not running yet. Never populate the live network from them; link to official documents instead.

## Geometry

`XML_GEOOBJECT_REQUEST` returns line geometry for the EFA map and needs operational line/trip
identities. Not used: the Zentrum plan is a fixed schematic, and trip sequences already carry stop
coordinates. `XML_STOPSEQCOORD_REQUEST` is used for its stop sequence (above), not its path.

## Live vehicle positions

KVV's map calls `https://projekte.kvv-efa.de/json?CoordSystem=WGS84` with a viewport (`MinY`,
`MinX`, `MaxY`, `MaxX`, `ts`) or a `JourneyKey`, every five seconds. Both forms returned HTTP 400,
including a key built exactly as KVV's JavaScript builds it. Rechecked 8 October 2026: the viewport,
`JourneyKey` and `vid` forms all answer 400, with or without kvv.de's referrer, origin and session
cookie, as do `/json/` and `/veloc`; an unknown path answers 404. CORS echoes any origin, so the
browser could read it if it answered. KVV's open data offers static GTFS and keyed TRIAS, neither
with positions. KARLA's marks are estimated from call times and must never be presented as GPS
positions.

## Payload observations

Examples, not guarantees; decompressed bodies.

| Request | Size |
| --- | ---: |
| Five basic departures at Hauptbahnhof (Vorplatz) | 68 kB |
| Five detailed departures with complete calls | 181 kB |
| Three basic departures | 37 kB |
| Three detailed departures with complete calls | 88 kB |
| One trip, all 54 calls | 39.5 kB |
| One trip, next 9 calls | 7.8 kB |
| Small nearby-stop bounding box | 7 kB |
| Stop search for a specific address | 3 kB |
| Timetable/line selection sample | 15 kB |
| Journey calculation | 118–171 kB |
| All-network notices filtered by date | 457 kB |

## Integration rules

1. Views receive domain data through `TransitSource`; they never call EFA.
2. Local stop ids stay separate from provider ids.
3. The live network is observed from current trips, never authored from timetable endpoints.
4. A plain board stays light and polls only while visible; the core observation idles on views that
   only borrow its signs and positions (`readsObservedNetwork` in `src/view-layout.ts`).
5. Whole-stop sequences stay on observation and topology cadences. A line's boards (which runs
   exist) and its runs (their calls, re-read at `LINE_RUN_READING_MAX_AGE_MS`) are two readings on
   two clocks; the ride reads on the board cadence.
6. No departure response is written to the service-worker cache.
7. Feed time anchors countdowns and freshness.
8. A failed refresh keeps the last successful reading with its real timestamp.
9. Schedules, predictions, notices and estimated positions are distinct facts, labelled separately.
10. Provider wording for platforms, notices, cancellations, diversions and accessibility is never
    replaced by inference.
11. A location-derived remote request needs an explicit privacy decision.
12. New provider fields need parser fixtures and tests for missing, singleton, array, malformed and
    contradictory forms.

## Candidate enhancements

1. Parse embedded `lineInfos`, `stopInfos` and `tripInfos`, deduplicated against published notices.
2. Keep notice attachments, additional links and exact validity intervals.
3. Carry stop-finder coordinates into dynamic stop registration.
4. Use `tStOTType=NEXT` where calls before the boarding stop are not needed (5× smaller).
5. An arrivals display, given a real use case.
6. A separate long-distance board at Hauptbahnhof.
7. Remote nearby-stop discovery, after the privacy decision.
8. Links to official timetable documents.

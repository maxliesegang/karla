# KVV EFA API reference

This document records the KVV EFA interfaces relevant to KARLA. The operator's CC0 GTFS archive,
which the app reads only offline, is covered in [kvv-gtfs.md](./kvv-gtfs.md). It combines the behavior used by
the application with behavior observed directly from the public KVV EFA installation.

> [!IMPORTANT]
> This is an empirical integration reference, not an official KVV or MENTZ API contract. The
> findings were last verified against the live service on **26 August 2026**. Treat undocumented
> fields and parameters as changeable, handle missing data defensively, and re-verify behavior
> before building a feature around it.

KARLA is not a journey planner. The journey-planning endpoint is documented for completeness and
future investigation, but it is not currently proposed as a product feature.

## Base URL and transport

```text
https://projekte.kvv-efa.de/sl3-alone/
```

The useful endpoints accept HTTP `GET` requests and return JSON when passed:

```text
outputFormat=json
```

The tested `sl3-alone` endpoints mirror the caller's `Origin` in
`Access-Control-Allow-Origin`, so browser GET requests from a static GitHub Pages application work
without a backend. Use only simple request headers. In particular, do not attempt to set
`User-Agent` or add custom headers that would cause an unnecessary preflight.

Requests should be bounded by an abort timeout. KARLA currently uses eight seconds.

### Common parameters

| Parameter | Typical value | Purpose |
| --- | --- | --- |
| `outputFormat` | `json` | Request JSON rather than the EFA HTML interface. |
| `coordOutputFormat` | `WGS84[DD.ddddd]` | Return coordinates as longitude and latitude in decimal degrees. |
| `language` | `de`, `en`, `fr` | Language used for provider-generated names and messages. |
| `type_*` | `stopID`, `any`, `coord` | Describes the corresponding `name_*` input. |
| `name_*` | provider stop ID, query, or coordinate | The corresponding input value. |
| `mode` | `direct` | Resolve and execute the request without the interactive HTML workflow. |

`coordOutputFormat` affects output coordinates. When it is omitted, EFA commonly returns its
projected `MRCV` grid, which is not directly usable with ordinary web maps.

### JSON conventions and irregularities

EFA JSON is a serialization of an XML-shaped model, not a stable idiomatic JSON schema:

- A repeated child is sometimes one object and sometimes an array.
- Empty collections may be `null`, absent, an empty array, or an empty object.
- Booleans and numbers are usually strings such as `"0"`, `"1"`, and `"10"`.
- Time values use several unrelated shapes across endpoints.
- Provider-local wall times generally carry no UTC offset.
- `parameters` is an array of `{ name, value }` records rather than an object.
- A successful HTTP response may still contain an EFA warning or unresolved input.

Normalize these variations at the provider boundary. Do not expose them to views.

Useful response metadata includes:

```json
{
  "name": "serverTime",
  "value": "2026-08-26T00:10:12"
}
```

Countdowns must be anchored to this feed clock, not to the device clock. Like every other time here
it is a bare local timestamp with no offset, so it must be resolved to a real instant rather than
parsed as the viewer's local time. Its seconds are not counted: the feed's own `countdown` is a
difference of whole minutes, and counting them puts every row a minute below the display beside it.

## Endpoint overview

| Endpoint | Role | KARLA status |
| --- | --- | --- |
| [`XSLT_DM_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_DM_REQUEST?) | Departures, arrivals, realtime state, optional stop sequences | In use |
| [`XML_TRIPSTOPTIMES_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XML_TRIPSTOPTIMES_REQUEST?) | One observed trip's calls and times | In use for a selected trip |
| [`XSLT_STOPFINDER_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_STOPFINDER_REQUEST?) | Stop and location search | In use for stops |
| [`XSLT_ADDINFO_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_ADDINFO_REQUEST?) | Published service notices | In use |
| [`XSLT_COORD_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_COORD_REQUEST?) | Stops and objects inside a bounding box | Verified, not in use |
| [`XSLT_TRIP_REQUEST2`](https://projekte.kvv-efa.de/sl3-alone/XSLT_TRIP_REQUEST2?) | Door-to-door journey calculation | Verified, out of scope |
| [`XSLT_SELTT_REQUEST`](https://projekte.kvv-efa.de/sl3-alone/XSLT_SELTT_REQUEST?) | Select timetable or line variants | Verified, not in use |
| `XML_STOPLIST_REQUEST` | Every stop of a municipality, with its locality | In use offline by `scripts/refresh-stop-catalog.ts` (`rapidJSON` only) |
| `XML_SERVINGLINES_REQUEST` | Lines serving one stop | Verified, not in use — GTFS answers it for every stop at once |
| `XSLT_STT_REQUEST` | Stop timetable document/data | Available, not in use |
| `XSLT_TTB_REQUEST` | Line timetable document/data | Available, not in use |
| `XSLT_ROP_REQUEST` | Line route-plan document/data | Available, not in use |
| `XSLT_ROUTE_REQUEST` | Printable route material | Available, not in use |
| `XML_GEOOBJECT_REQUEST` | Line geometry | Available, not in use |
| `XML_STOPSEQCOORD_REQUEST` | Stop-sequence geometry | Available, not in use |
| `https://projekte.kvv-efa.de/json` | Nominal live vehicle positions | Returned HTTP 400; do not use |

## Departure monitor: `XSLT_DM_REQUEST`

This is KARLA's primary live endpoint.

### Minimal live departure request

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

| Parameter | Values | Verified behavior |
| --- | --- | --- |
| `type_dm` | `stopID` | Treat `name_dm` as a provider stop ID. |
| `name_dm` | e.g. `7000089` | Stop or stop-complex ID to read. |
| `mode` | `direct` | Perform the board request directly. |
| `useRealtime` | `1` | Ask for live predictions. The response may still contain scheduled-only rows. |
| `itdDateTimeDepArr` | `dep`, `arr` | Select departures or arrivals. |
| `limit` | positive integer | Limit the returned events exactly. This is the main bandwidth control. |
| `useProxFootSearch` | `0` | Read this stop only. Without it the board may spend rows on neighbouring stops. |
| `line` | `servingLine.stateless`, repeatable | Restrict the board to those line-directions. See below. |
| `coordOutputFormat` | `WGS84[DD.ddddd]` | Return usable stop coordinates. |

### Departures versus arrivals

With `itdDateTimeDepArr=dep`, events are returned in `departureList`.

With `itdDateTimeDepArr=arr`, events are returned in `arrivalList`; the server does not merely put
arrival events into `departureList`. A client supporting both should normalize the two roots before
parsing individual events.

Example:

```text
https://projekte.kvv-efa.de/sl3-alone/XSLT_DM_REQUEST?outputFormat=json&type_dm=stopID&name_dm=7000089&mode=direct&limit=10&itdDateTimeDepArr=arr
```

### Requested date and time

```text
itdDateDayMonthYear=27.08.2026
itdTime=10:00
itdDateTimeDepArr=dep
```

This returns a board beginning around the requested feed-local time. The returned `countdown` is
relative to the requested board time, not to `parameters.serverTime`. A future board therefore
cannot use KARLA's normal live-countdown path unchanged.

Future results tested with `useRealtime=1` still correctly returned no `realDateTime`, no delay, and
`realtime: "0"`. Never infer a live prediction merely because realtime was requested.

### Transport-mode filters

KVV's departure-monitor form applies mode filters through its `std3` macro:

```text
std3_commonMacro=dm
includedMeans=checkbox
std3_inclMOT_0Macro=true   # train
std3_inclMOT_1Macro=true   # S-Bahn / Stadtbahn group exposed by the form
std3_inclMOT_4Macro=true   # tram
std3_inclMOT_5Macro=true   # bus
```

Only send the selected mode macros. A request containing only `std3_inclMOT_4Macro=true` returned
tram and no bus or train departures.

Example tram-only board:

```text
https://projekte.kvv-efa.de/sl3-alone/XSLT_DM_REQUEST?outputFormat=json&type_dm=stopID&name_dm=7000089&mode=direct&limit=10&std3_commonMacro=dm&includedMeans=checkbox&std3_inclMOT_4Macro=true
```

The macros filter by mode *group*, not by `motType`, and the groups are coarser than the board's
own values. Measured at Karlsruhe Hauptbahnhof (`7000090`) on 30 August 2026:

| Macro | `motType` values it returns |
| --- | --- |
| `std3_inclMOT_0Macro` | `0` Zug (ICE, IC, TGV, and rail replacement), `13` R-Bahn, `16` FlixTrain |
| `std3_inclMOT_1Macro` | `1` S-Bahn / Stadtbahn |
| `std3_inclMOT_4Macro` | `4` Straßenbahn |
| `std3_inclMOT_5Macro` | `5` Bus, `6` Ersatzverkehr, `7` Fernbus (`Flixbus (Sondertarif)`) |

So long-distance rail cannot be dropped while regional trains are kept, and long-distance coaches
cannot be dropped while city buses are kept. A macro of the group's own number for a dragged-in
value — `std3_inclMOT_7Macro=true` alone — returned nothing at all.

The macros compose with `line`, `depType=stopEvents` and `includeCompleteStopSeq=1`, and they also
narrow `servingLines`: unfiltered, Hauptbahnhof stated 83 line-directions, of which 43 were Fernbus.

KARLA asks every board for `1`, `4` and `5` and drops the coaches again by `motType` when the
answer is read, both from the rows and from the serving directions a coverage read would query.
`limit` is spent before that second pass, so a coach still costs a row.

### Line filter: `line`

Send `servingLine.stateless` values as repeated `line` parameters to restrict the board to those
lines. Unlike `lineRestriction` below, this one works exactly: a two-value request returned nothing
but the named line.

`stateless` ids are **per direction** — `kvv:21003:E:H:s26` and `kvv:21003:E:R:s26` are the two
directions of Linie 3 — so covering a line means sending both. KARLA already carries the value on
every departure as `routeDirectionId`.

The filter's real effect is on horizon rather than on transfer. `limit` is spent on whatever the
board returns, and an unfiltered Zentrum post spends it across every line calling there.

Measured at Europaplatz-U (`7001004`) on 26 August 2026, with `depType=stopEvents` and
`includeCompleteStopSeq=1`:

| Request | Rows | Horizon | Rows of Linie 3 | Wire (gzip) |
| --- | --- | --- | --- | --- |
| unfiltered, `limit=40` | 40 | 21 min | 8 | 237 kB |
| `line` ×2 (Linie 3), `limit=40` | 40 | 92 min | 40 | 318 kB |
| `line` ×2 (Linie 3), `limit=20` | 20 | 42 min | 20 | 161 kB |

Twenty-three distinct line/direction combinations competed for the forty unfiltered rows, which is
why that board reaches only twenty minutes ahead. A vehicle starting a forty-five-minute run at the
end of a line is on no Zentrum board at all until it is roughly halfway in.

Two cautions:

- **`lineInfos` is repeated per row and could not be suppressed.** Each row of a line under
  diversion carried the same ~16.5 kB notice blob, so even a *basic* filtered board of a diverted
  line was 733 kB raw for 86 kB on the wire. `useLineInfo=0`, `lineInfo=0`, `showLineInfo=0`,
  `itdLPxx_showAddInfo=0` and `genMaps=0` all returned byte-identical responses. It compresses away
  but still costs parse and heap; notices already have their own endpoint and cadence.
- **A filtered answer does not describe the stop.** Its `servingLines` covers only what was asked
  for, so it must never be recorded as the stop's serving directions.

An *unfiltered* board's `servingLines.lines[].mode.diva.stateless` lists the line-directions the
monitor knows at that stop, including ones no returned row mentions. That makes it a useful set of
query candidates for a follow-up filtered read — but it is scheduled metadata, never evidence of a
departure, so nothing from it may be rendered without a live row behind it.

### Sizes are raw, not wire

The byte counts in this document are decompressed sizes. The server sets
`Content-Encoding: gzip` when asked, and these responses compress by roughly 6-8×: the detailed
unfiltered board above is 1.34 MB raw and 237 kB on the wire. Judge transfer by the wire figure and
parse cost by the raw one.

### Batched stop sequences

KARLA uses these parameters together for bounded line and topology observations:

```text
depType=stopEvents
includeCompleteStopSeq=1
```

Observed behavior:

| Parameters | Result |
| --- | --- |
| Neither | No complete sequence |
| `depType=stopEvents` only | No sequence in the tested response |
| `includeCompleteStopSeq=1` only | Small or partial sequence |
| Both | Complete `prevStopSeq` and `onwardStopSeq` |

In a three-departure sample, the response grew from about 37 kB to 88 kB when complete sequences
were requested. A busy board with more departures can be much larger. Preserve KARLA's rule:

- A plain live board stays basic, and twenty rows is the budget: to see further, filter by `line`
  rather than raise `limit`.
- A plain stop may make one slow, cached topology read no more than every 30 minutes. Anything that
  *completes* a board — filling directions too sparse to appear in twenty rows — is a reading with
  its own life, not part of the 30-second cycle, and is the one read allowed past the row budget:
  a single filtered answer covers every sparse direction at once, which is cheaper than one request
  per line. Its held rows are published only where they are further out than the reading is old.
- A line is observed from a few detailed boards spread along it, never one per stop.
- A selected line's departures use the single-trip endpoint below, capped at the few vehicles a
  diagram can mark and re-read more slowly than the board beside them.

## Single trip: `XML_TRIPSTOPTIMES_REQUEST`

This endpoint returns one trip rather than every detailed departure at a stop. Its locator comes
from a basic DM row; `RealtimeTripId` alone is not accepted.

| Request parameter | DM field |
| --- | --- |
| `tripCode` | `servingLine.key` |
| `line` | `servingLine.stateless` |
| `stopID` | `stopID` |
| `date` | scheduled `dateTime`, formatted `YYYYMMDD` |
| `time` | scheduled `dateTime`, formatted `HHMM` |

Also send `outputFormat=json`, `coordOutputFormat=WGS84[DD.ddddd]`, `useRealtime=1`, and
`tStOTType=ALL|NEXT|PREVIOUS`. `ALL` is required for a complete ride; `NEXT` is cheaper when only
the remaining calls matter. The response carries `parameters.serverTime`, `vehicleCallAtStop`,
`mode`, and `stopSeq`.

Integration cautions:

- The working KVV path begins `XML_`; `XSLT_TRIPSTOPTIMES_REQUEST` returned HTTP 400.
- Missing, wrong, `tripId`-only, and `RealtimeTripId`-only locators returned HTTP 200 with an empty
  `stopSeq`. Validate a non-empty sequence and the echoed `vehicleCallAtStop` tuple.
- Read realtime from each call's `arrValid` / `depValid`, delay, and `realtimeStatus` fields.
  `mode.realtime` remained `"0"` for a trip whose calls carried valid predictions.
- Cancellation was stated as `TRIP_CANCELLED` on the calls. Preserve it; `-9999` is still the
  no-prediction sentinel.
- Keep the DM row as the stop-specific departure fact (countdown, platform, destination, hints and
  notices) and merge the single-trip sequence into it.
- A trip locator is provider state, not a stable URL identity. Deep links first rediscover it from
  a live board using KARLA's `tripId`.

One observed 54-call trip was about 39.5 kB with `ALL` and 7.8 kB/9 calls with `NEXT`; a one-row
detailed DM response for the same trip was 62.5 kB. Sizes vary with notices and service shape.

### Event fields useful to KARLA

The following fields have been observed on departure entries:

| Field | Meaning and cautions |
| --- | --- |
| `stopID` | Provider stop ID for the actual event. One requested complex may return several IDs. |
| `nameWO` / `stopName` | Stop name without/with locality depending on the field. |
| `countdown` | Minutes from the board's requested time. Use feed time for a live board. |
| `dateTime` | Scheduled local date and time. |
| `realDateTime` | Predicted local date and time, when supplied. |
| `platform` | Bare platform code used as identity. |
| `platformName` | Display form, often including the provider's platform word. |
| `pointType` | Provider's word such as `Gleis` or `Bstg.`. Do not infer it from mode. |
| `realtimeStatus` | Stop-event realtime status, including cancellation states. |
| `realtimeTripStatus` | Whole-trip state such as cancellation, diversion, or extra trip. |
| `servingLine` | Line, destination, mode, delay, hints, and operational identity. |
| `operator` | Operator code, name, and public code. |
| `attrs` | Trip IDs and planned vehicle accessibility attributes. |
| `lineInfos` | Notices embedded against the line/event. |
| `stopInfos` | Notices embedded against the stop. |
| `tripInfos` | Notices embedded against the trip. |
| `prevStopSeq` / `onwardStopSeq` | Detailed calls when requested. |

`servingLine.hints` has carried both vehicle facts and operating reasons, including:

- `Niederflurwagen`
- `Stufenloses Fahrzeug, WLAN, WC, Klimaanlage`
- `Nicht barrierefreies Fahrzeug`
- Delay or incident explanations

Match negation before positive accessibility vocabulary. Absence of a hint means unknown, not
inaccessible.

Useful `attrs` include:

```text
RealtimeTripId
AVMSTripID
PlanLowFloorVehicle
PlanWheelChairAccess
```

`servingLine.trainNum` is useful relationship evidence. On the observed S8 joined working from
Karlsruhe to Freudenstadt/Bondorf, both separately addressed rows carried train number `85653`,
while the continuing portion additionally carried `AVMSTripID` `85653-2`. There is no explicit
coupling flag: only combine that number with a matching line and departure fact, plus call sequences
whose shorter route is a strict prefix and whose mutually published schedule times agree.

The detailed stop references can additionally contain:

```text
gid
areaGid
pointGid
zone
niveau
coords
```

`pointGid` may distinguish physical boarding positions more precisely than a displayed platform
code. It remains a provider identity and should not leak into KARLA routes.

### Realtime interpretation

Use the expected time published by the feed:

1. Scheduled time comes from `dateTime` or a sequence's scheduled fields.
2. Prediction comes from `realDateTime` when valid.
3. A delay sentinel of `-9999` means no prediction, not a very early vehicle.
4. `arrDateTimeSec` in a stop sequence is scheduled time; delay is carried separately.
5. Cancellation and diversion states must override ordinary delay presentation.

A request containing `useRealtime=1` is not evidence that every returned row is realtime.

`servingLine.delay` is not a second account of `realDateTime`: it is truncated where the prediction
is not. Over 500 monitored rows at 26 stops (30 August 2026) `realDateTime` equalled `dateTime +
delay` on 368 and ran one minute later on 19 — never earlier. Eleven of those carried `delay: 0`,
which read from the delay alone publishes the schedule and calls a late trip punctual. Neither field
appeared without the other.

On those rows the feed contradicts itself: `countdown` follows `dateTime + delay`, not its own
`realDateTime`, so no reading agrees with both. KARLA follows the prediction (rule 2), leaving its
countdown a minute above the platform display on about one row in twenty.

### Parameters that did not provide useful DM filtering

The live form exposes accessibility controls:

```text
imparedOptionsActive=1
lowPlatformVhcl=on
wheelchair=on
noSolidStairs=on
noEscalators=on
noElevators=on
```

The server echoed these options as active but still returned a departure explicitly described as
`Nicht barrierefreies Fahrzeug`. Do not use these parameters to claim an accessible-only board.
Read each event's stated vehicle information instead.

These parameters were also accepted or ignored without producing useful departure filtering in the
tested KVV installation:

```text
lineRestriction=403
maxTimeLoop=...
mergeDep=1
equivs=1
itdLPxx_depOnly=1
```

At Karlsruhe Hauptbahnhof, `lineRestriction=403` still returned InterCity and Flixbus entries. It
may affect journey calculation, but it is not a reliable departure-monitor filter here.

`useAllStops=0` versus `useAllStops=1` made no difference for the tested Europaplatz stop-complex
ID: both returned the surface and underground provider stops. Use the actual IDs returned on each
event rather than assuming this option controls complex membership.

`itdLPxx_template`, `itdLPxx_snippet`, `sessionID`, `requestID`, and similar fields are HTML client
plumbing and are unnecessary for a direct JSON board.

## Stop finder: `XSLT_STOPFINDER_REQUEST`

KARLA currently uses:

```text
XSLT_STOPFINDER_REQUEST
  ?outputFormat=json
  &type_sf=any
  &name_sf=Marktplatz
  &anyObjFilter_sf=2
  &coordOutputFormat=WGS84[DD.ddddd]
```

`anyObjFilter_sf=2` asks the finder for stops only. Measured against `Kaiserstr`, the unfiltered
answer is 269 results — 123 stops, 145 streets, 1 POI — while the filtered one is 230, all stops:
the non-stop objects were not extra information, they were crowding stops out of a capped answer.

`locationServerActive=1` was sent until now and made no difference to either query measured
(`Marktplatz`, `Kaiserstr`, byte-identical answers), so it was dropped.

`type_sf=stop` looks like the more direct narrowing but is a *different*, nationwide index: it
answers with neither `anyType` nor `ref.coords` (`Kaiserstr` returns 74 stops from Aachen to
Ahlbeck), so no result can be placed inside the network's area. Keep `type_sf=any`.

### Result types

`stopFinder.points` can contain several `anyType` values:

| `anyType` | Meaning | Relevance without journey planning |
| --- | --- | --- |
| `stop` | Public transport stop | In use |
| `singlehouse` | Resolved street address | Low |
| `street` | Street | Low |
| `poi` | Point of interest | Low |
| `loc` | Locality or district | Low |

KARLA correctly keeps only `stop` results today. Address and POI results become useful mainly for
journey planning.

Stop results can supply:

```text
stateless
ref.id
ref.gid
ref.place
ref.coords
name
mainLoc
quality
```

The coordinates are useful even without journey planning: a newly searched stop could participate
in local nearby ranking immediately rather than waiting for a detailed trip sequence to register
its position.

Provider IDs remain behind `TransitSource`. URLs continue to use stable local IDs.

## Published notices: `XSLT_ADDINFO_REQUEST`

KARLA currently requests notices valid today:

```text
XSLT_ADDINFO_REQUEST
  ?outputFormat=json
  &filterDateValid=26.08.2026
  &filterPublicationStatus=current
```

`filterDateValid` uses network-local `DD.MM.YYYY` format. Without the date filter, the endpoint can
return notices for the whole KVV area and a substantially larger payload.

### Publication state

The endpoint keeps withdrawn records in its response. A notice should be treated as published only
when all of these are true:

```text
publish == "1"
valid == "1"
deactivated != "true"
```

Do not interpret the continued presence of a withdrawn entry as an active notice.

### Useful notice fields

| Field | Use |
| --- | --- |
| `infoID` and `seqID` | Together identify a particular revision. |
| `priority` | Normal or high priority. |
| `infoLink.infoLinkText` | Operator-published title. |
| `infoLink.infoLinkURL` | Operator's full notice page. |
| `infoLink.htmlText` | Full HTML body; must be sanitized if rendered. |
| `infoLink.attachments` | Replacement timetables, diagrams, and other operator PDFs. |
| `infoLink.additionalLinks` | Related operator pages. |
| `validityPeriod` | One or more exact active intervals. |
| `publicationDuration` | Publication window, distinct from operational validity. |
| `creationTime` | Source creation time. |
| `concernedLines` | Structured lines, directions, and affected places. |
| `concernedStops` | Structured affected stops and provider IDs. |
| `affectDMRequest` | Whether the publisher marked it as affecting departure-monitor results. |
| `affectTripRequest` | Whether it affects journey results. |
| `affectTimetable` | Whether it affects timetable data. |

KARLA currently reduces multiple validity periods to their earliest start and latest end. That is
an honest outer span but loses gaps. A future enhancement may preserve and display the exact
intervals.

Operator attachments and additional links can be added to the existing notice disclosure without
rewriting the notice. Do not render raw `htmlText` without a deliberate sanitization policy.

The endpoint's own URLs may use `http://host:80/...` even though the same document is available over
HTTPS. KARLA upgrades these links to HTTPS to avoid mixed-content navigation.

### Embedded notices versus the all-network endpoint

Basic departure entries already carry `lineInfos`, `stopInfos`, and `tripInfos`. Parsing those may:

- Attach a notice to the exact event that returned it.
- Expose operator links already paid for in the board payload.
- Improve stop/line association.

They do not replace the published-notice view: a board reading and an announcement are separate
facts. Embedded and global records should be deduplicated by provider identity where possible.

In one live sample the filtered all-network notice response was about 457 kB, so keep it on its
slower cadence and never couple it to the 30-second departure refresh.

## Coordinate search: `XSLT_COORD_REQUEST`

This endpoint returns stops or other objects inside a geographic bounding box.

Example shape:

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

The empty `boundingBox=` parameter was required in the tested request; without it, the corner
parameters were not interpreted.

| Parameter | Meaning |
| --- | --- |
| `boundingBoxLU` | Northwest corner as `longitude:latitude:format`. |
| `boundingBoxRL` | Southeast corner as `longitude:latitude:format`. |
| `type_1=STOP` | Return stops. |
| `inclFilter=1` | Enable the typed inclusion filter. |
| `coordOutputFormat` | Coordinate format for returned pins. |

Stop pins have included:

```text
id
stateless
desc
locality
coords
distance
STOP_GLOBAL_ID
STOP_NAME_WITH_PLACE
STOP_MAJOR_MEANS
STOP_MEANS_LIST
STOP_MOT_LIST
STOP_TARIFF_ZONES:kvv
```

A small Hauptbahnhof-area request returned six stops in about 7 kB.

### Possible KARLA use and privacy constraint

The endpoint could discover nearby KVV stops that are not yet authored or observed by KARLA. It
must not silently replace the current local-only ranking:

- The current geolocation implementation does not send the rider's position anywhere.
- A bounding-box request sends an area derived from that position to KVV.
- The response describes timetable stops, not proof of current service.

If ever introduced, make it an explicit action such as “Weitere Haltestellen in der Nähe suchen”,
and confirm a selected stop with a live board before adding it to the observed network.

The related `XML_COORD_REQUEST` endpoint returned the same JSON schema when `outputFormat=json` was
used. Prefer one stable spelling rather than mixing both.

## Journey calculation: `XSLT_TRIP_REQUEST2`

This endpoint is documented for completeness. Journey planning is currently out of scope for
KARLA.

### Core inputs

```text
type_origin=stopID
name_origin=7000089
type_destination=stopID
name_destination=7001001
std3_commonMacro=trip
outputFormat=json
coordOutputFormat=WGS84[DD.ddddd]
```

Origins, destinations, and via points can be stops, arbitrary search values, addresses, POIs, or
coordinates.

Coordinate input example:

```text
type_origin=coord
name_origin=8.411860:49.009415:WGS84[DD.ddddd]
```

In testing, EFA reverse-geocoded this coordinate to Kaiserstraße 12 and returned assigned nearby
stops with walking distances and walking times.

### Verified options

| Capability | Parameters |
| --- | --- |
| Date and time | `itdDateDayMonthYear`, `itdTime` |
| Depart/arrive by | `itdTripDateTimeDepArr=dep\|arr` |
| Realtime request | `useRealtime=1` |
| Fastest | `routeType=LEASTTIME` |
| Fewest changes | `routeType=LEASTINTERCHANGE` |
| Least walking | `routeType=LEASTWALKING` |
| Maximum changes | `maxChanges=9\|0\|1\|2` |
| Maximum walking time | `trITMOTvalue100=5\|10\|15\|20\|30` |
| Nearby alternative stops | `useProxFootSearch=on` |
| Via point | `type_via`, `name_via` |
| Via dwell | `dwellTimeMinutes` |
| Local transport | `lineRestriction=403` |
| Accessibility panel | `imparedOptionsActive=1` plus the options below |

Form-derived options such as `routeType` and `useProxFootSearch` applied reliably only when
`std3_commonMacro=trip` was included.

Transport-mode filtering uses the same form macros described for the departure monitor, together
with `includedMeans=checkbox`.

Accessibility options exposed by the trip form are:

```text
noSolidStairs
noEscalators
noElevators
lowPlatformVhcl
wheelchair
```

The response schema also lists generic EFA options such as `noCrowded`, `assistance`, `SOSAvail`,
`noLonelyTransfer`, `illumTransfer`, `overgroundTransfer`, and `noInsecurePlaces`. Some were ignored
by this KVV installation. Do not expose one without separately validating it.

Even a recognized accessibility option expresses a routing constraint, not proof that the whole
result is accessible. Inspect returned legs, platforms, levels, walking instructions, and vehicle
hints before making a claim.

### Journey response

Observed journey data includes:

- Multiple alternatives
- Total duration, distance, and interchange count
- Transit and walking legs
- Scheduled and realtime point times
- Planned and actual platforms
- Complete stop sequences
- Operator and operational line/trip identities
- Vehicle and incident hints
- Transit and walking geometry in `path`
- Turn-by-turn walking instructions in `turnInst`
- KVV tariff zones, base fares, and ticket alternatives

Tested journey responses were roughly 118–171 kB. They are suitable for explicit one-shot actions,
not polling.

The `trips` root itself changed shape between tested responses: multiple transit alternatives were
an array, while a single walking result appeared under an object wrapper. Apply the same
object-or-array normalization used elsewhere in EFA parsing.

### Earlier and later results

The HTML interface exposes:

```text
command=tripPrev
command=tripNext
command=tripFirst
command=tripLast
```

These commands rely on EFA session/request state and cookies. A static application should prefer a
new stateless request with an adjusted explicit time so results remain shareable and do not depend
on cross-origin session cookies.

## Timetable and line-document endpoints

The public EFA navigation exposes:

| Endpoint/workflow | Purpose |
| --- | --- |
| `XSLT_SELTT_REQUEST?itdLPxx_page=stt` | Select an official stop timetable. |
| `XSLT_SELTT_REQUEST?itdLPxx_page=ttb` | Select an official line timetable. |
| `XSLT_SELTT_REQUEST?itdLPxx_page=rop` | Select an official line route plan. |
| `XSLT_STT_REQUEST` | Produce stop-timetable output. |
| `XSLT_TTB_REQUEST` | Produce timetable-table output. |
| `XSLT_ROP_REQUEST` | Produce route-plan output. |
| `XSLT_ROUTE_REQUEST` | Produce printable route material. |

A selection request such as:

```text
XSLT_SELTT_REQUEST
  ?outputFormat=json
  &type_seltt=stopID
  &name_seltt=7000089
  &lineReqType=8
```

returned line variants with:

```text
number
destination
description
operator
timetablePeriod
valid-from / valid-to
stateless line identity
isSTT / isTTB / isROP availability
```

The response included future construction variants that were not currently running. These
endpoints are therefore useful for explicitly scheduled documents or outbound links, but they must
not populate KARLA's observed live network.

The document-generation workflow is more stateful and PDF-oriented than the direct JSON endpoints.
A simple link to the official KVV document is safer than reimplementing it unless a concrete
feature requires structured timetable data.

## Geometry endpoints

The KVV JavaScript references:

```text
XML_GEOOBJECT_REQUEST
XML_STOPSEQCOORD_REQUEST
```

Both returned JSON when called with `outputFormat=json`. They are intended to supply line and
stop-sequence paths for the EFA map. `XSLT_GEOOBJECT_REQUEST` and an empty
`XML_STOPSEQCOORD_REQUEST` also responded, but meaningful requests require operational line/trip
identities.

KARLA already receives stop coordinates and trip sequences from detailed departure boards. These
geometry endpoints add little value today:

- The Zentrum view is deliberately a list, not a map.
- Detailed board calls already support the ride and line diagram.
- A line should be learned from current observed trips, not from a planned route object.

Do not add them without a feature whose value justifies the extra payload and another provider
schema.

## Live vehicle-position endpoint

KVV's own map JavaScript is configured to call:

```text
https://projekte.kvv-efa.de/json?CoordSystem=WGS84
```

The JavaScript adds either a viewport:

```text
MinY
MinX
MaxY
MaxX
ts
```

or a `JourneyKey` derived from EFA's DIVA trip identity, and expects a five-second refresh.

Both request forms returned HTTP 400 during verification, including a key constructed exactly as
the KVV JavaScript constructs it. The endpoint is currently not a viable integration. Even if it
becomes available, a five-second vehicle feed requires a separate bandwidth, privacy, freshness,
and failure-state design.

KARLA's current estimated vehicle marks remain based on predicted call times and must never be
presented as GPS positions.

## Payload observations

These are examples, not guaranteed sizes:

| Request | Approximate response size observed |
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
| Current all-network notices filtered by date | 457 kB |

Responses may be compressed on the wire; the figures above are downloaded response bodies from
the observed requests. Content varies substantially when embedded notices are present.

## KARLA integration rules

Any new use of these APIs must preserve the following boundaries:

1. Views receive domain data through `TransitSource`; they never call EFA directly.
2. Stable local stop IDs remain separate from provider IDs.
3. The live network is observed from current trips, not authored from timetable endpoints.
4. A plain board stays lightweight and polls only while visible; the shared core observation drops
   to an idle cadence on views that only borrow its line signs, stop positions and interchanges
   (`isObservedNetworkInView` in `src/view-layout.ts`).
5. Batched complete sequences stay on observation/topology cadences; a selected trip is fetched
   alone from its locator while other same-line vehicles remain bounded batch observations.
6. No departure response is written to the service-worker cache.
7. Feed time anchors countdowns and freshness.
8. Failed refreshes retain the last successful reading with its real timestamp.
9. Scheduled data, predictions, notices, estimated positions, and actual vehicle positions are
   distinct facts and are labeled separately.
10. Provider wording for platforms, notices, cancellations, diversions, and accessibility is not
    replaced by inference.
11. A location-derived remote request requires an explicit privacy decision; current nearby ranking
    remains local.
12. New provider fields need parser fixtures and tests for missing, singleton, array, malformed, and
    contradictory forms.

## Candidate enhancements excluding journey planning

In priority order:

1. Parse embedded `lineInfos`, `stopInfos`, and `tripInfos`, deduplicating them against published
   notices while keeping announcements separate from board readings.
2. Preserve notice attachments, additional links, and exact validity intervals in the existing
   notice disclosure.
3. Carry stop-finder coordinates into dynamic stop registration so searched stops can be ranked
   locally without waiting for a detailed trip.
4. Use `tStOTType=NEXT` for single-trip reads that need no calls before the boarding stop (5× less).
5. Add an explicitly addressed arrivals display if there is a real rider/display use case.
6. Offer a mode-specific board beyond the local network KARLA already asks for — the long-distance
   rail one at Hauptbahnhof would need its own display, not a row on a tram board.
7. Consider explicit remote nearby-stop discovery only after resolving the location-privacy change.
8. Offer links to official KVV timetable documents where useful, without treating planned variants
   as the live network.

The nominal vehicle-position endpoint, generic geometry endpoints, and ineffective departure
filters should remain out of scope until their behavior or product value changes.

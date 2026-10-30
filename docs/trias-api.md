# TRIAS API reference

The TRIAS 1.2 interface (VDV-431) as observed with KARLA's access, and how the app reads it.
Network-specific facts are in [networks/](./networks/).

> [!IMPORTANT]
> An empirical reference, measured 15–26 October 2026 with `npm run probe:trias` and hand-written
> requests, and NVBW's access side by side on 29 October 2026. Re-verify before building on a
> behaviour.

## Access

```text
POST https://projekte.kvv-efa.de/liesegangtrias/trias
Content-Type: text/xml
```

- Authentication is the `siri:RequestorRef` in the request body. It is a secret: keep it in
  `.env.local` (`TRIAS_REQUESTOR_REF`), never in the repo or the shipped bundle.
- An unknown ref is answered `403 Forbidden` ("IP address or user agent rejected").
- Requests with `version="1.1"` and `"1.2"` both work, as do UTC timestamps with or without
  milliseconds.
- The same access answers for all of Baden-Württemberg.

Browsers cannot call it directly: the `OPTIONS` preflight is answered `501`, and a `text/plain`
body `400`. The app reads it through [proxy/](../proxy/README.md); scripts run by hand read it
directly (`scripts/trias-direct.ts`).

### NVBW's access

MobiData BW (NVBW) grants a second access to the statewide EFA. Nothing reads it yet.

```text
POST https://efa-bw.de/trias
```

- Its ref is `TRIAS_BW_REQUESTOR_REF` in `.env.local`. NVBW's terms forbid passing it on, so it
  too stays out of the client.
- NVBW's factsheet lists `TripRequest`, `RefineRequest` and `FaresRequest` beside the requests
  below, and seven days of past timetables ([dataset](https://www.mobidata-bw.de/dataset/trias)).
- The `OPTIONS` preflight is answered `200` with `Access-Control-Allow-Origin: *`.

Measured against KARLA's access with the same requests:

- **Journey codes differ.** One journey, with the same times and predictions, is
  `kvv:21004:E:H:s26:1537` on KARLA's access and `kvv:21004:E:H:s26:1151` on NVBW's. A
  `TripInfoRequest` with the other access's `JourneyRef` answers no calls. Line refs, stop points
  and `OperatingDayRef` agree. **One dated journey cannot be read from both.**
- **DB's copies of KVV's S-Bahn.** Boards add `ddb:920S1`, `ddb:92S11` and `ddb:920S2` rows
  beside KVV's S1, S11 and S2, at the same timetabled times, at the stop rather than a bay
  (`de:08212:37`), without a prediction: 7 of 40 rows at Europaplatz.
- **No `Extension`**: neither `TransportTypeName` nor `PublishedJourneyNumber`. A long-distance
  train's category and number are in `PublishedLineName` alone (`IC 1941 InterCity`).
- **More notices.** Europaplatz's board carried 3 situations against 1, adding the network's
  planned works (VBK construction phases, night track work); Stuttgart Hbf's 26 against 14.
- **Predictions stay on past departures** for about an hour: a board an hour back stated 446
  `EstimatedTime`s, KARLA's access none. Neither states any three hours back.
- **`TripRequest` routes.** Hauptbahnhof → Marktplatz answered 4 trips with tram legs, fares
  (`Einzelfahrschein (Erwachsene)` 3.70) and, with `IncludeLegProjection`, `LegTrack` geometry of
  70–92 positions per tram leg. KARLA's access answered one walk.
- Warm boards took 350–400 ms with spikes to 1.4 s (KARLA's access about 280 ms); one connection
  failed once.
- The same on both: `TripInfoRequest` calls, stop search, no `CurrentPosition`, an empty
  `LineInformationRequest`, timetables 14 days back.

## Responses

- Times are UTC (`2026-10-15T12:53:18Z`). `kvv:` and `frb:` times carry seconds; the other pools
  read state whole minutes.
- Calls state `ServiceArrival` and `ServiceDeparture` separately, so dwell times are visible.
- `EstimatedTime` is absent where a call has no prediction. Its presence is not always realtime:
  `ddb:` trains state it even for tomorrow, and `din:` and `frb:` often state it equal to the
  timetable (`frb:` 67 of 68 within three hours, 28 October 2026). `kvv:` and `vrn:` state none
  more than three hours ahead.
- `PtMode` is `rail` from KVV's S-Bahn to the ICE; `RailSubmode` tells them apart:
  `suburbanRailway`, `replacementRailService`, `local` and `regionalRail` (RE, RB),
  `highSpeedRail`, `interregionalRail` and `international` (ICE, IC, EC).
- A long-distance `PublishedLineName` may be the line (`12`) or the train with its name
  (`ICE 266 Baden-Kurier`); `Extension` states `TransportTypeName` (`InterCityExpress`) and the
  train number.
- `Service` states the journey's `OriginStopPointRef` and `DestinationStopPointRef`.
- `OperatorRef` is the NVBW GTFS `agency_id` (`ddb:GA` ↔ `ddb-GA`, Arverio); `ddb:00` is all of
  DB, S-Bahn Stuttgart and S-Bahn Rhein-Neckar alike.
- No reply states a line colour.
- `Attribute` carries vehicle notes (`Niederflurwagen`); `Deviation` marks a diverted journey;
  `EstimatedBay` a changed bay; `Extension` the train category and number.
- Elements are namespaced `trias:` and `siri:`; text values sit in `<Text>` + `<Language>` pairs.
- Stop names may carry the municipality as a prefix (`KA Marktplatz (Kaiserstraße U)`).
- A journey's layover is timed through, not ended and restarted.
- Response times were 50–250 ms for boards and trip info, 0.3–5 s for location searches.

## Identities

| Element | Example | Meaning |
| --- | --- | --- |
| `JourneyRef` | `kvv:21005:E:R:s26:302` | the journey; the last segment is its code |
| `OperatingDayRef` | `2026-10-15` | the dated journey's day, which differs from the calendar day after midnight |
| `LineRef` | `kvv:21005:E:R` | one direction of a line; `DirectionRef` is `inward` / `outward` |
| `StopPointRef` | `de:08212:37:6:6` | a DHID at stop, area or quay level; the bay is in `PlannedBay` (`Gleis 6`) |

- Refs lead with a **pool**. Pools seen include `kvv:`, `vvs:`, `frb:`, `vrn:`, `din:`, `hnv:`,
  `tub:`, `sbg:` and `ddb:`. A pool is not a Verbund: `ddb:` carries S-Bahn Stuttgart, S-Bahn
  Rhein-Neckar and long-distance trains; `kvv:` runs to Heilbronn.
- The variant segment may be empty (`vvs:20015::H`), a digit or a letter; line numbers may be
  alphanumeric (`ddb:920S6`, `ddb:90RE4`).
- One name runs in several pools (S1 is `kvv:22301` and `ddb:920S1`), and one `ddb:` line number
  carries two names (`ddb:90RE4:5:H` is RE40, `ddb:90RE4:D:H` RE45).
- A stop-level DHID (`de:08212:1004`) is accepted as `StopPointRef` and answers that stop's bays.
- A journey calling twice at one stop (Europaplatz Gleis 6 then Gleis 4) appears as two stop
  events.

## Requests

| Request | KARLA use | Notes |
| --- | --- | --- |
| `StopEventRequest` | boards | with `IncludePreviousCalls` / `IncludeOnwardCalls` every event carries its journey's calls; without `DepArrTime` it starts at the provider's now |
| `TripInfoRequest` | one dated journey, line routes | `JourneyRef` + `OperatingDayRef`; returns all calls |
| `LocationInformationRequest` | stop search, the stop catalog | by name, or by position (below) |
| `TripRequest` | none | KARLA's access answers walks only; NVBW's answers routes (above) |

- **A board answers only the stop asked for.** Two stops at one place (a tunnel and the street
  above it) are two boards.
- `LineFilter` **excludes** the listed lines unless it carries `<Exclude>false</Exclude>`. A line
  ref matches with or without the timetable suffix (`kvv:21005:E:R:s26`); whether `kvv:21005:E`
  covers both directions is unverified. A `DirectionRef` beside it is ignored. A filtered board
  honours the row count, reaching hours ahead.
- A stop with nothing due answers an `ErrorMessage` (code `-4030`, `STOPEVENT_LOCATIONUNSERVED` or
  `STOPEVENT_NOEVENTFOUND`) instead of an empty list.
- `TripInfoRequest` with `IncludePosition` returned **no `CurrentPosition`**: no vehicle positions.

### Stops by position

`LocationInformationRequest` takes a position instead of a name (`Restrictions/Type` `stop`):

| `InitialInput` | Answer |
| --- | --- |
| `GeoRestriction/Rectangle` (`UpperLeft`, `LowerRight`) | every stop whose centre lies inside, as a `StopPoint` with its stop DHID, its name without the municipality, `LocalityRef` (`8212000:6`), the district as `LocationName` (`Durlach`) and one position; honours `NumberOfResults` |
| `GeoRestriction/Circle` (`Center`, `Radius`) | the same, but reaches only about 0.65 of `Radius` |
| `GeoPosition` alone | one `StopPlace` per bay, board-style names, ranked by `Probability`; ignores `NumberOfResults` |

An area without stops answers an `ErrorMessage` with code `-20100` and no text. Depot and turning
points (`Tullastraße (44)`) are not listed.

## What TRIAS does not state

- **Serving lines**: no request answers them; a `LineInformationRequest` got an empty reply. One
  board with calls at each of the Zentrum's observation posts taught 273 of KVV's 430 rail
  directions at 20 rows, 341 at 60. What stayed missing ran rarely or not that day.
- **Notices** (situations) come only with boards, in `StopEventResponseContext` as SIRI
  `PtSituation`s, and only those of the rows' lines. A planned one has `SituationNumber`,
  `Version`, `ValidityPeriod`, `Summary`, an HTML `Detail`, a description starting
  `Linien: S2, S12, 1, …`, and `Affects` naming line refs with a trailing colon but no line
  numbers. An ad-hoc one has a summary only. A big notice is repeated in every board it concerns
  (17 kB).
- **Vehicle positions**: none (above).

## How KARLA reads it

`TriasClient` (`src/data/trias-client.ts`) reads boards, dated journeys and stop search through the
proxy, and `src/data/trias-parsers.ts` decodes them into the feed model (`src/data/feed.ts`):

- A stop is its stop-level DHID (`toStopPointId`). A stop place's board reads each of its stop
  points and joins them (`fetchStopPlaceBoard`); the joined board ends where a full board's rows ran
  out. A part's board reads its stop point alone.
- Every pool's rows are read; demand-responsive buses are not. Only the network's pools
  (`NetworkScope`) are observed, credited to serving directions and completed by coverage reads.
- Rail is `lightRail` (S-Bahn, rail replacement), `regionalRail` or `longDistanceRail` by its
  submode. A long-distance train is named by category and number (`ICE 377`, `readTrainName`).
- `JourneyRef` is the journey; split at its last colon, it gives the line ref. A dated journey is
  its `JourneyRef` on its `OperatingDayRef`, which is all a `TripInfoRequest` needs; the asking
  row's own call is found by stop point and timetabled time.
- `EstimatedTime` is the prediction; its absence means "nach Fahrplan". An `EstimatedTime` more
  than three hours ahead is not one, nor one equal to the timetable in `frb:` or `din:`. Delays are
  the predictions' rounded minutes; times stay to the second, and only `kvv:` and `frb:`
  predictions count as stated to the second.
- The network's municipality prefix (`KA `) is removed and the place set to it; other names are
  kept.
- `Age` from the proxy advances `ResponseTimestamp`, the feed clock.
- Calls without a position are placed by `StopRegistry`: at their rail bay (GTFS, by stop and bay
  code), else at the catalog's stop, else where the stop was registered.
- A line route is the calls of the dated journey it is addressed through.
- Boards state no serving lines; `ServingDirections` (`src/data/serving-directions.ts`) credits
  each dated journey read to every stop it calls at, for six hours, and a whole-stop board names
  those.
- Situations are not read: the proxy strips the block. `parseTriasSituations` decodes it from a
  reply that keeps it.

Responses require well-formed XML, the endpoint's payload and a valid feed timestamp. An invalid
reading keeps the last complete board with its original age. A rate limit pauses proxy reads until
`Retry-After` (one minute when absent). `VITE_TRIAS_PROXY_URL` (`src/data/trias-proxy.ts`) points
the app at another proxy; development reads use Vite's same-origin forwarding to the deployed one.

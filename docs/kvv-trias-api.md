# KVV TRIAS API reference

The KVV's TRIAS 1.2 interface (VDV-431) as observed with KARLA's access, and how the app reads it.
The EFA JSON feed it complements is covered in [kvv-efa-api.md](./kvv-efa-api.md).

> [!IMPORTANT]
> Measured on **15–17 October 2026** with `npm run probe:trias` and side-by-side reads against EFA
> at Marktplatz, Europaplatz, Hauptbahnhof, Mühlburger Tor, Durlach Bahnhof and Durlacher Tor. An
> empirical reference: re-verify before building on a behaviour.

## Access

```text
POST https://projekte.kvv-efa.de/liesegangtrias/trias
Content-Type: text/xml
```

- Authentication is the `siri:RequestorRef` in the request body. It is a secret: keep it in
  `.env.local` (`TRIAS_REQUESTOR_REF`), never in the repo or the shipped bundle.
- An unknown ref is answered `403 Forbidden` ("IP address or user agent rejected"); before the
  access was enabled the same request returned `200` with an empty body.
- Requests with `version="1.1"` and `"1.2"` both work, as do UTC timestamps with or without
  milliseconds.

## Browsers cannot call it directly

| Request | Response |
| --- | --- |
| `OPTIONS` preflight | `501 Not Implemented`, though `Access-Control-Allow-Origin` mirrors the origin |
| `POST`, `text/xml` | `200` (needs a preflight in a browser, which fails) |
| `POST`, `text/plain` | `400` |

A browser client therefore needs a proxy, independent of keeping the ref secret: see
[proxy/](../proxy/README.md).

## Responses

- Times are UTC (`2026-10-15T12:53:18Z`) and carry **seconds**; about 80 % of timetabled and
  estimated times have non-zero seconds.
- Calls state `ServiceArrival` and `ServiceDeparture` separately, so dwell times are visible.
- `EstimatedTime` is absent where KVV lines have no prediction (28 of 40 Europaplatz departures
  had one; the later ones did not). DB trains (`ddb:` refs) state it even for tomorrow, equal to the
  timetable, so for them it is no evidence of realtime.
- `Attribute` carries vehicle notes (`Niederflurwagen`); `Deviation` marks a diverted run;
  `EstimatedBay` a changed platform; `Extension` the train category and number.
- Elements are namespaced `trias:` and `siri:`; text values sit in `<Text>` + `<Language>` pairs.
- Response times were 50–250 ms.

## Identities

| TRIAS | Example | EFA equivalent |
| --- | --- | --- |
| `JourneyRef` | `kvv:21005:E:R:s26:302` | `{servingLine.stateless}:{tripCode}` (`kvv:21005:E:R:s26` + `302`) |
| `OperatingDayRef` | `2026-10-15` | the run's operating day, which EFA run keys lack |
| `LineRef` | `kvv:21005:E:R` | `servingLine.stateless` without the timetable suffix |
| `DirectionRef` | `inward` / `outward` | `R` / `H` in the line ref |
| `StopPointRef` (call) | `de:08212:37:6:6` | the EFA stop point; the bay is in `PlannedBay` (`Gleis 6`) |

- All 30 stop events matched an EFA board row of the same run through `JourneyRef`.
- The EFA stop id (`7000037`) is accepted as `StopPointRef` in a `StopEventRequest`; EFA accepts
  a DHID (`de:08237:1050`) as `name_dm` in turn.
- Karlsruhe's EFA ids are `7` and the DHID's stop number to six digits (`de:08212:1003` is
  `7001003`; all 389 catalog stops). Elsewhere the numbers differ (`de:08235:9711` is `7001305`).
- **A board answers only the stop asked for**, where EFA answers the whole complex: Marktplatz's
  `7001003` omits the Pyramide (`7001011`).
- A `LocationInformationRequest` for "Europaplatz" returned `de:08212:1004`, which also yields
  departures.
- A run calling twice at one stop (Europaplatz Gleis 6 then Gleis 4) appears as two stop events.

## Against EFA

EFA's whole minutes are the TRIAS times truncated, not rounded:

| TRIAS timetabled → estimated | TRIAS delay | EFA |
| --- | --- | --- |
| 13:13:54 → 13:14:42 | 48 s | 13:13, 0 min |
| 13:18:18 → 13:19:48 | 90 s | 13:18, 1 min |

## Requests

| Request | KARLA use | Notes |
| --- | --- | --- |
| `LocationInformationRequest` | stop search | `Restrictions/Type` `stop` |
| `StopEventRequest` | boards | with `IncludePreviousCalls` / `IncludeOnwardCalls` every event carries its run's calls (11–32 here); without `DepArrTime` it starts at the provider's now |
| `TripInfoRequest` | one run | `JourneyRef` + `OperatingDayRef`; returns all calls |

`LineFilter` **excludes** the listed lines unless it carries `<Exclude>false</Exclude>`. A line ref
matches with or without the timetable suffix (`kvv:21005:E:R`, `kvv:21005:E:R:s26`); whether
`kvv:21005:E` covers both directions is unverified. A `DirectionRef` beside it is ignored.

`TripInfoRequest` with `IncludePosition` returned **no `CurrentPosition`**: no vehicle positions.

A stop with nothing due answers an `ErrorMessage` (code `-4030`, `STOPEVENT_LOCATIONUNSERVED` or
`STOPEVENT_NOEVENTFOUND`) instead of an empty list. Every board repeats the notices in force in
`StopEventResponseContext`, about a tenth of the reply.

## Against EFA, field by field

Of 112 runs read from both at six stops, every row agreed on line, direction id, mode, destination,
platform kind, train number, step-free access, status and delay (within the minute EFA truncates).
The differences:

| | TRIAS | EFA |
| --- | --- | --- |
| Times | to the second; predictions per call end | the minute, truncated; delays in minutes |
| Stop names | locality prefixed (`KA Marktplatz (Kaiserstraße U)`, `Wolfartsweier Nord`) | without locality, `place` beside it |
| Call positions | none | every call but the board's own |
| Platform | missing at some DB stations and outside Karlsruhe | stated |
| Board's own call | once | twice at a run's origin |
| Mid-run layover | timed through (Turmberg 21:56–22:15) | marked as a run end (`depValid=0`) |
| Mode | S-Bahn and Stadtbahn are `rail` / `suburbanRailway` | `motType=1` |
| Line-filtered board | honours the row count, reaching hours | answered two rows of line 1 for forty asked |

## How KARLA reads it

`KvvTriasClient` (`src/data/kvv-trias-client.ts`) reads boards, single runs and stop search through
the proxy and decodes them into the shared feed model (`kvv-feed.ts`) with
`kvv-trias-parsers.ts`:

- A complex's board asks each of its stops (`findComplexProviderStopIds`) and joins the rows.
- Stop refs become provider ids by the rule above; elsewhere the stop's DHID stands in.
- `JourneyRef` is the trip id; split at its last colon, it gives the locator's line and trip code,
  so run keys match EFA's. The locator also carries `OperatingDayRef`.
- `EstimatedTime` is the prediction; its absence means "nach Fahrplan". Delays are the predictions'
  rounded minutes; times stay to the second (`predictedArrivalTime`, `predictedDepartureTime`).
- The `KA ` / `Karlsruhe ` prefix is removed and the place set to Karlsruhe; other names are kept.
- `Age` from the proxy advances `ResponseTimestamp`, the feed clock.
- Unlocated calls are placed by `StopRegistry`: the catalog's position in Karlsruhe, else the one
  the stop was registered with; stops met only in TRIAS calls outside the city stay unlocated.
- Serving lines come from a one-row EFA board, kept six hours per stop; line routes and notices from
  EFA.

Responses require well-formed XML, the endpoint's payload and a valid feed timestamp. Invalid
readings retain the last complete board with its original age.

`KvvFeedSelection` selects EFA after two consecutive logical reads fail through transport, timeout
or server errors; proxy access denial selects it immediately. Lookup and protocol errors stay
local. Rate limits pause proxy reads until `Retry-After` (one minute when absent).

After five minutes, the next required read probes TRIAS; concurrent reads stay on EFA until it
succeeds. A provider transition retires incompatible run readings and coverage supplements.
Each timed reading carries its feed session. Late responses cannot publish; retained boards keep
their original times and never merge with a new feed session. `DepartureBoardReadings` owns board
reuse, shared requests and retention.

A board read interrupted by a provider transition retries once against the active feed.
Development reads use Vite's same-origin forwarding path to the deployed proxy.

`VITE_TRIAS_PROXY_URL` points the app at another proxy, or, set empty, at EFA alone.

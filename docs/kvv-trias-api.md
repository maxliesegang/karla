# KVV TRIAS API reference

The KVV's TRIAS 1.2 interface (VDV-431) as observed with KARLA's access. Not used by the app yet.
The EFA JSON feed it would replace or complement is covered in [kvv-efa-api.md](./kvv-efa-api.md).

> [!IMPORTANT]
> Measured on **15 October 2026** with `npm run probe:trias` at Europaplatz (`7000037`). An
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
- Every stop event carried an `EstimatedTime`, delay 0 included. Whether that marks a prediction or
  a copied timetable time is not yet established; until it is, it is not evidence of realtime.
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
- The EFA stop id (`7000037`) is accepted as `StopPointRef` in a `StopEventRequest`.
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

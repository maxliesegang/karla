# TRIAS proxy

A thin PHP proxy in front of the KVV TRIAS interface ([docs/trias-api.md](../docs/trias-api.md)).
It holds the requestor ref, builds the TRIAS request from a few validated parameters, and serves
the XML reply gzipped from a 15 s shared cache. Parsing stays in the client
(`src/data/trias-client.ts`).

## Endpoints

| Endpoint | Parameters |
| --- | --- |
| `GET /api/stop-events.php` | `stop` (a `de:` ref), `rows` (1–60, default 20), `calls` (`0`/`1`), `kind` (`departure`/`arrival`), `lines` (up to 16 line refs, comma-separated) |
| `GET /api/trip-info.php` | `journey` (`JourneyRef`), `day` (`OperatingDayRef`, `YYYY-MM-DD`) |
| `GET /api/locations.php` | `q` (2–60 characters; cached for an hour), `rows` (1–20, default 10); or `box` (`south,west,north,east`, at most three decimals and 0.05° a side; cached for a day), `rows` (1–200, default 200) |

Replies are XML with `Cache-Control: no-store` and `Age`, the seconds the reply sat in the cache;
the client advances the reply's `ResponseTimestamp` by it. Boards lose their situation block
(`StopEventResponseContext`), which the app does not read. `https://maxliesegang.github.io` is
allowed by CORS besides the proxy's own origin.

`Age`, `Retry-After` and `Date` are exposed to allowed browser origins on success and failure.

Provider errors such as `ERROR_INVALID_JOURNEY_REF` arrive as a TRIAS `ErrorMessage` in a 200
reply and are passed through. The proxy's own errors are JSON (`{"error": "…"}`) with 400, 405,
429 (over 300 upstream requests per minute and client; cached answers are not counted), 502 (upstream failed) or 503 (no ref configured).
No response carries upstream error details.

## Layout on the server

The app folder sits outside every other domain's webroot, so only its own subdomain reaches it.

```text
<app folder>/
  trias-config.php   copied by hand from trias-config.example.php; outside the webroot
  cache/             created by the proxy
  analytics/         private app-open and proxy totals
  public/            the subdomain's document root; the deploy FTP user is limited to it
    api/  lib/       from proxy/public/ (lib/ is denied by .htaccess)
```

## Local

`npm run dev` forwards TRIAS reads through Vite to the deployed proxy. To use the local PHP proxy,
start it below and run Vite with `VITE_TRIAS_PROXY_URL=/api/`.

```bash
npm run proxy        # php -S localhost:8080, with TRIAS_REQUESTOR_REF from .env.local
curl 'http://localhost:8080/api/stop-events.php?stop=de:08212:37&rows=5'
```

The ref is read from `trias-config.php` one level above `public/`, else from `TRIAS_REQUESTOR_REF`.
Needs PHP 8.3+ with curl and zlib.

## Usage counts

`POST /api/app-open.php` accepts an empty request from the two production app origins and returns
204. Other methods, origins, query parameters and nonempty bodies are rejected. Do Not Track and
Global Privacy Control requests do not increment the count. No TRIAS key is needed.

Totals live in `<app folder>/analytics/daily-opens.json`, outside `public/` and the deployment's
FTP scope. PHP creates the directory with mode 0700 and the totals with mode 0600. Updates are
locked and replaced atomically. Days follow `Europe/Berlin`; only dates and counts are stored:

```json
{
  "2026-11-01": 42,
  "2026-11-02": 57
}
```

Read or download this file using your hosting account's file manager or a separate FTP account
with access to the app folder. It is not available through the website or the deployment login.
Daily totals are kept until the file is deleted. Deploys and TRIAS cache pruning leave them alone.

Counts measure app starts, not unique visitors; reloads count again and offline requests are lost.
Origin checks limit browser submissions, but cannot prevent forged requests or bots.

The counter never records IP addresses, browser identifiers, referrers or request bodies. HTTP
requests still expose connection information to the host. Check All-Inkl's access/error log
settings separately: disable access logging for this endpoint where supported, or minimize its
retention. The app's usage-count notice does not replace a hosting privacy notice.

## Proxy metrics

Feed endpoints collect daily operation totals in
`<app folder>/analytics/proxy/YYYY-MM-DD.json`. Read these through the hosting account, like the
app-open totals. Files are private (0600), outside the webroot, deployment and cache pruning.
Days follow the request's start time in `Europe/Berlin`. Totals remain until deleted.

Each file contains `stop_events`, `trip_info`, `location_search` and `location_area` entries for
the operations received that day. Each entry has these fields:

| Field | Meaning |
| --- | --- |
| `requests` | Incoming requests, including invalid and rejected requests |
| `cache_hits` | Replies reused without an upstream call, including a cache filled while waiting |
| `upstream_requests` | Actual TRIAS attempts, after rate-limit checks |
| `upstream_failures` | Transport errors, non-200 replies, or replies rejected by the proxy's existing checks |
| `upstream_timeouts` | Timeouts; a subset of `upstream_failures` |
| `responses` | Counts by final HTTP status: 200, 400, 405, 429, 500, 502 or 503 |

`responses["429"]` counts rate limits; 500 and 503 identify proxy failures; 502 identifies failed
upstream reads. An `ErrorMessage` inside a TRIAS HTTP 200 reply remains a passed-through response,
not an `upstream_failure`. These metrics do not validate the feed's XML or its contents.

For one operation, `cache_hits / responses["200"]` gives the cached fraction of HTTP 200 replies
when that denominator is nonzero. Compare operations separately: boards and journeys cache for
15 seconds, name searches for an hour, area searches for a day.

One best-effort update runs at request shutdown, using a nonblocking lock and atomic replacement.
A busy, corrupt or unavailable metrics store skips the update without retries or changing the
response. Counts can therefore understate traffic. A process terminated before shutdown is also
not recorded. No external service or additional browser request is involved.

Only fixed operation names, daily counts and response statuses are stored. No client information,
request parameters, precise timestamps or response content is retained. These operational totals
include scripts, development traffic and bots; they do not measure people.

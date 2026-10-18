# TRIAS proxy

A thin PHP proxy in front of the KVV TRIAS interface ([docs/kvv-trias-api.md](../docs/kvv-trias-api.md)).
It holds the requestor ref, builds the TRIAS request from a few validated parameters, and serves
the XML reply gzipped from a 15 s shared cache. Parsing stays in the client
(`src/data/kvv-trias-client.ts`).

## Endpoints

| Endpoint | Parameters |
| --- | --- |
| `GET /api/stop-events.php` | `stop` (EFA id or `de:` ref), `rows` (1–60, default 20), `calls` (`0`/`1`), `kind` (`departure`/`arrival`), `lines` (up to 16 line refs, comma-separated) |
| `GET /api/trip-info.php` | `journey` (`JourneyRef`), `day` (`OperatingDayRef`, `YYYY-MM-DD`) |
| `GET /api/locations.php` | `q` (2–60 characters; cached for an hour), `rows` (1–20, default 10) |

Replies are XML with `Cache-Control: no-store` and `Age`, the seconds the reply sat in the cache;
the client advances the reply's `ResponseTimestamp` by it. Boards lose their notice block
(`StopEventResponseContext`), which the app reads from EFA. `https://maxliesegang.github.io` is
allowed by CORS besides the proxy's own origin.

`Age`, `Retry-After` and `Date` are exposed to allowed browser origins on success and failure.

Provider errors such as `ERROR_INVALID_JOURNEY_REF` arrive as a TRIAS `ErrorMessage` in a 200
reply and are passed through. The proxy's own errors are JSON (`{"error": "…"}`) with 400, 405,
429 (over 120 requests per minute and client), 502 (upstream failed) or 503 (no ref configured).
No response carries upstream error details.

## Layout on the server

```text
/karla/
  trias-config.php   copied by hand from trias-config.example.php; outside the webroot
  cache/             created by the proxy
  public/            the domain's document root; the deploy FTP user is limited to it
    api/  lib/       from proxy/public/ (lib/ is denied by .htaccess)
```

## Local

`npm run dev` forwards TRIAS reads through Vite to the deployed proxy. To use the local PHP proxy,
start it below and run Vite with `VITE_TRIAS_PROXY_URL=/api/`.

```bash
npm run proxy        # php -S localhost:8080, with TRIAS_REQUESTOR_REF from .env.local
curl 'http://localhost:8080/api/stop-events.php?stop=7000037&rows=5'
```

The ref is read from `trias-config.php` one level above `public/`, else from `TRIAS_REQUESTOR_REF`.
Needs PHP 8.3+ with curl and zlib.

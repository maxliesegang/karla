# KARLA

A static React + TypeScript + Vite site showing live Karlsruhe public transport departures.
See the [README](./README.md) for the data source and station-board parameters.

## Commands

```bash
npm run dev
npm run build          # tsc -b && vite build — run before handing off a change
npm run lint
npm run format         # biome format --write . — the formatter is the style authority
npm test
npm run refresh:stops  # regenerates src/data/generated from the operator's published data
```

`dist` is built and deployed by GitHub Actions on push to `main`; don't commit it.

## Layout

| Path | Role |
| --- | --- |
| [src/App.tsx](src/App.tsx) | the shell: picks a panel, hands views their data |
| [src/routing.ts](src/routing.ts) | hash routes and path builders |
| [src/selection.ts](src/selection.ts) | resolving the stop / line / trip chain against live data |
| [src/view-layout.ts](src/view-layout.ts) | what an address means for the two panels: which is shown, which is wide, panel keys |
| [src/hooks/](src/hooks/) | route, network, board, trip, and clock subscriptions |
| [src/components/](src/components/) | one file per view, plus shared badge, chip, termini, footer |
| [src/lib/](src/lib/) | domain logic: observed network, feed clock, trip progress, notices |
| [src/data/](src/data/) | `TransitSource` boundary, EFA client and parsers, stop and line data |
| [src/data/generated/](src/data/generated/) | written by [scripts/](scripts/) from published data; never edited by hand |
| [src/index.css](src/index.css) | the whole visual system |
| [public/](public/) | icons, manifest, and `sw.js` — the offline app shell |
| [tests/](tests/) | `node --test` over the pure modules; no DOM, no network |

## Naming

One concept, one name, everywhere it appears — the Zentrum is `zentrum` in code even where its
published URL segment is still `/center`.

- **Components.** `*View` is a whole route view, one per `RouteView` (`ZentrumView`, `NetworkView`,
  `NearbyStopsView`, `ServiceNoticesView`, `StationBoardView`). `*Panel` is a half of the dashboard
  or a section inside a view (`DepartureBoardPanel`, `LineDiagramPanel`, `RideStatusPanel`,
  `ServiceNoticePanel`). Everything else is named for what it is: badge, chip, row, list, tabs, menu.
  A component exported from a file the file is not named after belongs in its own file.
- **Modules.** A module is named for the concern its exports name, so a hook module and the pure
  module beneath it share a name — `hooks/departure-board-collection.ts` over
  `lib/departure-board-collection.ts`. Filenames drop the `use` prefix that the hooks inside carry.
- **`get*` derives an answer from what it is handed; `find*` searches through data for one.** Either
  may come back with nothing — that is in the return type, not in the verb.
- **Constants carry the whole noun**, not the shortened one the module could get away with:
  `DEPARTURE_BOARD_REFRESH_MS`, not `BOARD_REFRESH_MS`.
- **CSS classes are kebab-case of the component that owns them**, and a view's root class ends
  `-view`.

## Constraints

- **No backend, no secrets.** Must stay deployable to GitHub Pages as plain files.
- **The network is observed, not kept.** Served stops and their lines come from live trips; a line
  that stops running leaves the view by itself.
- **Bandwidth is a design constraint.** Rows are the budget: a view that needs to see further asks
  for one line, not for more rows. Hidden pages neither poll nor tick.
- **Views never touch a provider.** Fetching, id resolution, and merging live behind `TransitSource`.
- **Routing is hash-based and goes through `routePaths`.** Components get routing, data, and time as
  props and never touch `window`.
- **A bundle is a view, not an identity.** Two lines may be *read* together over the stretch they
  have been observed sharing at one stop, addressed `line/S1+S11` and chosen by the rider.
  `lib/line-families.ts` stays the statement of line identity and never merges them.
- **Each level of the chain drops back on its own.** Never drop a level on a feed failure, and never
  pin a level the rider did not choose.

## Data honesty

- Never claim realtime for data that isn't; without a prediction a departure reads "nach Fahrplan".
- Count minutes against the feed's clock (`lib/feed-clock.ts`), never the device's, and at the
  minute it shows — the operator's own board does, and a rider is holding ours up against it.
- A failed refresh is not evidence the last board was wrong: keep it and state its age.
- One published time per row — the one the vehicle is expected at, read from the feed's prediction
  where it made one (`findExpectedDepartureInstant`) rather than from the delay it states beside it.
  The countdown, the printed time and the board's order all come from that one instant.
- Quote service notices, never rewrite them.

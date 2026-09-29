# KARLA

A static React + TypeScript + Vite site showing live Karlsruhe public transport departures.
See the [README](./README.md) for the data source and station-board parameters.

## Commands

```bash
npm run dev
npm run build          # tsc -b && vite build
npm run lint
npm run format         # biome format --write . — the formatter is the style authority
npm test               # tests and build must pass before handing off a change
npm run refresh:stops  # regenerates src/data/generated from the operator's published data
npm run solve:zentrum  # measures the Zentrum plan against the feed, and solves for a truer one
```

`dist` is built and deployed by GitHub Actions on push to `main`; don't commit it.

## Layout

| Path | Role |
| --- | --- |
| [src/App.tsx](src/App.tsx) | the shell: picks a panel, hands views their data |
| [src/routing.ts](src/routing.ts) | hash routes and path builders |
| [src/selection.ts](src/selection.ts) | resolving the stop / line / trip chain against live data |
| [src/view-layout.ts](src/view-layout.ts) | what an address means for the two panels |
| [src/lib/](src/lib/) | domain logic: observed network, feed clock, trip progress, notices |
| [src/data/](src/data/) | `TransitSource` boundary, EFA client and parsers |
| [src/data/generated/](src/data/generated/) | written by [scripts/](scripts/) from published data; never edited by hand |
| [tests/](tests/) | `node --test` over the pure modules; no DOM, no network |

## Naming

One concept, one name: the Zentrum is `zentrum` in code even where its published URL segment is
still `/center`. Comments read British (`colour`, `centre`); identifiers read US
(`metersToNextCall`, `normalizePlatformCode`). A field the provider names keeps the provider's
spelling verbatim (`trainNum`, `stopSeqCoords`).

## Constraints

- **No backend, no secrets.** Must stay deployable to GitHub Pages as plain files.
- **The network is observed, not kept.** Served stops and their lines come from live trips; a line
  that stops running leaves the view by itself.
- **Hidden pages neither poll nor tick.** Rows are the bandwidth budget: a view that needs to see
  further asks for one line, not for more rows.
- **A line is read as rows, then as runs.** One trip request per run, never once per stop it has yet
  to call; boards and run readings keep their own clocks, the readings re-read at
  `LINE_RUN_READING_MAX_AGE_MS`.
- **A route is a seed, never an answer.** It decides which stops are *read*, never what is drawn: a
  stop nothing calls at today contributes an empty board and leaves the diagram by itself.
- **A filter is sent whole or not at all.** A one-direction board is silently incomplete; wait until
  both directions are named from the stop's own `servingLines`.
- **One reading of a run, and the source holds it.** `RunReadingStore` keeps one record per run;
  views keep the *ids* of the runs they follow and read them through `findRun`; `Departure.readAt`
  is set once and never rewritten. Every path out of the source ends at `findRun`, boards included,
  so one reading is one *object* and not merely one set of facts.
- **A run's calls are the record's, a stop's facts are the row's.** A `RunSequence` is what a run
  states about itself — the calls, one clock, the identity they refine — and carries nothing about
  any stop. A `Departure` becomes one through `toRunSequence`, which is where the discovering row's
  platform, countdown and id are dropped rather than carried into evidence every other stop reads.
- **A reading that lands nowhere is a failure and says so.** A request outlives the record it was
  shared under; `rememberSequence` reports whether it landed, so a caller backs off instead of
  counting a swallowed answer as a success.
- **A run is keyed by the provider's address for it: `line|tripCode`.** No date in the key — that
  splits a run at midnight to defend against a collision a day away. A record retires when its
  calls run out.
- **Only a run's own sequence places a vehicle.** A board row is a prediction about one call; the
  sequence is the only reading that states the whole run. The row corrects the sequence at its
  boarding call alone, and not once it is the older reading (`isRowSupersededBySequence`) or the
  departure is behind us. Widening a board's fan-out buys no liveness — only re-reading the run does.
- **Three keys address a run, and none stands in for another.** `getRunRecordKey` shares a run's
  evidence and requests, `getRunMarkKey` is the dated identity a drawn mark is followed by,
  `getBoardRowKey` collapses a board's two rows for one run.
- **Views never touch a provider.** Fetching, id resolution, and merging live behind `TransitSource`.
- **Routing is hash-based and goes through `routePaths`.** Components get routing, data, and time as
  props and never touch `window`.
- **A bundle is a view, not an identity.** Two lines may be *read* together over an observed shared
  stretch, addressed `line/S1+S11` and chosen by the rider; `lib/line-families.ts` never merges them.
- **Each level of the chain drops back on its own.** Never drop a level on a feed failure, and never
  pin a level the rider did not choose.

## Data honesty

- Never claim realtime for data that isn't; without a prediction a departure reads "nach Fahrplan".
- Count minutes against the feed's clock (`lib/feed-clock.ts`), never the device's.
- A failed refresh is not evidence the last board was wrong: keep it and state its age.
- One published time per row: countdown, printed time, and board order all come from the feed's
  predicted instant (`findExpectedDepartureInstant`), never from the delay stated beside it.
- Quote service notices, never rewrite them.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

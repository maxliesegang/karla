# Karla

A live board and line companion for public transport, read from TRIAS, one network per build
(KVV). These are the terms the code uses. Where two terms are easy to confuse, the entry says how
they differ.

## Stops

**Stop place** (`StopPlace`, `stopPlaceId`; a route's `stopId`): the app's own stop identity, with
one page and one URL (a slug such as `europaplatz`). It may join several stop points (Europaplatz's
street and tunnel): stop points of one name before its bracket, in one district, within 250 m, plus
the network's overrides (`stop-place-overrides.ts`), written to `generated/stop-places.ts`. Its
board reads each one. A stop beyond the catalog is a stop place of one stop point.
_Avoid_: complex, local stop, transit stop, alias

**Part** (`StopPlacePart`): one stop point of a joined stop place as the page names it (`Unten`,
`Oben`, `Vorplatz`, `Pyramide`), from the operator's bracketed aside. A board can be read at one
part (`#/stop/hauptbahnhof/vorplatz`).
_Avoid_: level (not every part is one)

**Stop point** (`stopPointId`): the operator's identity for a stop, a stop-level DHID
(`de:08212:1003`, TRIAS `StopPointRef`). Stop event facts such as the bay live at this level.
_Avoid_: provider id

**Bay** (`bay`, `bayText`, `bayKind`): the signed place at a stop point a vehicle stops at, TRIAS's
`PlannedBay`: its code (`3`), its text (`Gleis 3`) and whether it is a track or a stand.
_Avoid_: platform (in code; German copy says Gleis and Bstg.)

**Network / dynamic stop**: a network stop place ships with the app, from the catalog; a dynamic
stop is first met live (through a search hit or a call) and is registered for the rest of the
session.

**Boarding place**: what a rider walks to at a stop, usually one stop point. It is derived from
journeys calling at several bays in turn. The Zentrum plan reads its places from the corridors each
bay serves and how near bays stand, and draws one capsule per place.

## Boards and stop events

**StopEventBoard**: one reading of a stop's stop events: its rows, its status (live or unavailable)
and when it was read.
_Avoid_: departure board

**StopEvent**: one row, meaning one dated journey at one stop at the moment the board was read (a
TRIAS `StopEvent`). It holds facts about that stop (countdown, bay), not about the whole vehicle.
An arrival board's rows are stop events too.
_Avoid_: departure (for the row; the departure of a call is still its departure)

**Serving lines**: the line directions a stop is served by: what dated journeys read this session
were seen to call there. They are query candidates, not evidence that anything is running.

**Line ref** (`lineRef`): the provider's id for one direction of a line (`kvv:21005:E:R:s26`),
TRIAS's `LineRef`. It is used for board filters and is never shown to a rider.
_Avoid_: route direction id, direction id

**PtMode**: what kind of vehicle serves a line (tram, light rail, bus), after TRIAS's `PtMode`.
_Avoid_: transport mode

**Board order**: one of three orderings of a board: by time, by bay, or by line.

## Journeys

**Journey** (`journeyRef`): the timetable entry, which repeats every day; TRIAS's `JourneyRef`.
_Avoid_: trip (TRIAS's Trip is a passenger's planned itinerary)

**Dated journey** (`datedJourneyId`, `journeyRef@operatingDayRef`; `DatedJourneyRef`): one dated
instance of a journey on the road today, a `JourneyRef` on an `OperatingDayRef`. This is what gets
requested, tracked, drawn and addressed (`#/journey/:journeyRef/:operatingDayRef`).
_Avoid_: run, trip, locator

**Vehicle**: the mark drawn for a dated journey.

**Call**: one stop in a dated journey's sequence, with its times and bay (TRIAS `CallAtStop`). The
board's own call is its *this call* (`isThisCall`).
_Avoid_: trip call

**DatedJourneyCalls**: a dated journey's calls as the feed stated them, read at a single moment. It
holds nothing specific to one stop. Only a trip info request yields one; a board's embedded calls
are that board's observation.
_Avoid_: run sequence

**DatedJourneyReadingStore**: inside `TransitSource`, it holds the latest stop events and calls for
each dated journey. Every view reads dated journeys from it.

**Journey keys**:
- `getJourneyRecordKey` (dated; `data/dated-journey-reading-store.ts`)
  shares a dated journey's data and requests.
- `getDatedJourneyMarkKey` (dated; `lib/journeys.ts`) identifies a drawn vehicle.
- `getBoardRowKey` (`data/stop-event-dated-journeys.ts`) merges a board's duplicate rows for one
  dated journey.

**Published journey number** (`publishedJourneyNumber`): the train number a stop event states.
_Avoid_: train number

## Time

**Feed clock**: the operator's clock, anchored when a board is read and advanced by the device. All
countdowns and staleness checks use it.

**Timetabled / estimated time**: a call end's time from the timetable, and its prediction, after
TRIAS's `TimetabledTime` and `EstimatedTime`.
_Avoid_: scheduled, predicted

**Expected departure instant**: the estimated time if there is one, otherwise the timetabled one.
It is the one time a row is read against. TRIAS estimates to the second; delays print as whole
minutes.

## Lines

**Line**: the passenger-facing sign, such as "S1" or "2".

**Line identity** (`identity`): a line ref's pool and line number without direction
(`kvv:22301`, `vvs:20015`). The name stays the address: a line asked for by name is any row of that
name; one asked for by identity is only rows of that name and identity. Within `ddb:` it is not
unique: S-Bahn Stuttgart's S3 and S-Bahn Rhein-Neckar's S3 are both `ddb:920S3`.
_Avoid_: line key

**Line bundle**: two lines read together over a stretch they share, as chosen by the rider in the URL
(`line/S1+S11`). They are never merged automatically.

**Observed network**: the lines and stops seen live at the observation posts, the fixed stops read
to learn the network, and in every dated journey requested for its calls.

**Line observation**: the stops and directions learned for one line, which decide which boards to
read for it.

## Riding

**Ride**: one dated journey read on its own, for a rider on board.

**Ausstieg**: the stop where the rider plans to get off, as chosen by the rider and carried in the
URL.

## Zentrum

**Experiment page**: a place to try experimental maps, including the Zentrum plan.

**Geographic map**: the experiment page's `geo` map. Stops stand where the feed locates them,
linked in the order observed journeys call them, out to the journeys' ends. Places are named by the
feed's `placeName`. Like the region plan, it draws only **daily lines**: those the timetable runs on
every day of the week (`npm run refresh:stops` lists the others).

**Region plan**: the experiment page's `region` map. An octilinear plan of the observed network,
solved offline: in Karlsruhe only junctions and ends, every other place once per branch. Stops it
leaves out are ridden past. The Zentrum's stops keep the Zentrum plan's shape; its east–west axis
runs on from Entenfang to Durlach. The map shrinks with distance from Marktplatz by its **scale**:
a fisheye, zones, or arms (zones up to the city's edge, straight arms beyond it). Arm places are
ticks named on hover; ends, Karlsruhe and the axis are named. At rest it shows corridors; an opened
stop colours its lines.

**Plan options**: choices for how the Zentrum plan opens and displays paths, lines and travel times.
_Avoid_: experiments (the page contains experimental maps; these choices configure one plan).

**Zentrum**: the authored list of city-centre stops that the schematic covers. In code it is always
`zentrum`; on the experiment page its map is `center`.

**Schematic plan**: the authored drawing of that area (nodes, edges, lanes), solved offline and never
read live.

**Corridor**: a connection between two stops observed in journeys. A junction may split it into
several drawing edges; travel times and vehicle progress still measure the corridor stop to stop.

**Drawn track** (`trackId`): one lane in the schematic. Lines with the same trunk and colour share
a drawn track; their passenger-facing line identities remain separate.

**Junction**: a bend between stops, where a corridor from a stop with a platform run (Albtalbahnhof)
turns square into the street it serves. Drawn without a mark; corridors stay stop to stop for
journeys, lighting and travel times.

## Boundary

**TransitSource**: the only module that talks to the provider. Views use it and nothing else.

**Network** (`NetworkDefinition`): what the app knows about one network beyond the feed: its scope,
home municipality, stop places, stop catalog, bays and line colours (`src/networks/<id>/`). A build
reads one, `network`.

**Network scope** (`NetworkScope`): the network's own pools and area. Its pools' lines are the
network's: observed, numbered, coloured from its GTFS and given line pages. Boards keep every pool's
rows; a search lists stops in the area first. A pool is a ref's first segment (`kvv` in
`kvv:22304:E:H:s26`).

**Other operator's line**: a row of a pool outside the scope (`ddb:920S3`). It shows on boards with
its own heading and no line page, coloured from the community list by its journey's ends
(`OperatorArea`), else neutral by mode.

**Stop catalog**: the timetable's stops of the network's home municipality, generated by
`npm run refresh:stops`: names, positions, districts and how much service each has.

**Feed**: what the TRIAS feed answers, decoded (`feed.ts`), below `TransitSource`.

**TRIAS**: the operator's interface, read through `proxy/`. See [docs/trias-api.md](docs/trias-api.md).

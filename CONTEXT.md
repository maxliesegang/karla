# Karla

A live board and wayfinding companion for Karlsruhe public transport. The domain is what the
operator's feed states, what the rider chooses, and what the app observes — kept strictly apart.

## Stops and places

**Local stop**:
The app's stable stop identity; one page, one URL. May be a complex of several stop points.
_Avoid_: stop id (out of context), station

**Stop point**:
The operator's identity for where a vehicle physically stands; finer-grained than a local stop.
_Avoid_: stop (unqualified is ambiguous), platform

**Stop complex**:
One rider place (Europaplatz, Marktplatz) spanning several stop points. A board names the complex;
row facts live at stop-point grain.
_Avoid_: station

**Authored stop**:
A stop the app ships with by name. Stands opposite an observed one first met live.
_Avoid_: static stop

**Dynamic stop**:
A stop first met live (a search hit, a call in a sequence) and registered for the session.
_Avoid_: unknown stop, ad-hoc stop

**Alias**:
A second rider-facing name for a stop: colloquial name, municipality for out-of-town stops, or a
former name.
_Avoid_: alt name, search name

**Boarding place**:
The unit a rider walks to: what they must choose between before walking. Normally one stop point —
never platforms of two different stop points — but a stop point's platforms may be split apart
where trips publish the same tram at both. Derived from trips calling several platforms in turn,
not authored.
_Avoid_: platform, level, point (bare)

**Level**:
Not a term. The street-vs-tunnel character of a boarding place, which the operator communicates by
bracketing it into the stop point's name rather than by numbering it separately. Distinct from the
chain's levels — stop, line, trip — where the same word names where in the chain a view sits.
_Avoid_: using it as a noun in code

**PlatformCode**:
The bare code printed by the operator (`3`, `1(U)`), as opposed to its worded label — kept under
the label's own spelling.
_Avoid_: platform label

**Countdown**:
Minutes a rider has left, counted against the feed clock from the expected departure instant. The
name is the provider's (`countdown`); the reading is ours — minutes from the clock, never the
counter the feed prints beside a row, which ages the moment the board does.
_Avoid_: minutes, reading off the provider's countdown field

## Boards and rows

**DepartureBoard**:
What a local stop is serving: rows plus prior trip calls, one per request. The feed names its
answer a departure monitor (EFA's DM request), and the word is kept for what arrives.
_Avoid_: timetable, board (bare)

**Departure**:
One row: the rider-facing facts of one run at one stop at one instant of reading. Never a fact
about the vehicle as a whole.
_Avoid_: departure (as a whole trip), entry

**Run row vs. run distinction**:
See **Run**. A row is evidence about a run; it is not the run.
_Avoid_: board row (when speaking of the run)

**Serving lines**:
A stop's stated line–directions from scheduled metadata. Never evidence that a departure exists.
_Avoid_: stop's lines, line list

**Route direction id**:
The provider's per-direction identity of a line, named by the field itself (`servingLine.stateless`).
A family's two directions are two of these; board filters and direction coverage reason in them.
Spoken only between app and feed: run keys, locators, filters. Never shown to a rider.
_Avoid_: directionId (bare), direction (bare), provider line id

**Board order**:
One of the three readings of a board: by time, by platform, by line.
_Avoid_: sort, view

**DepartureStatus**:
How much of a row is measured: realtime, by schedule, cancelled, or diverted.
_Avoid_: delay status

## Runs and readings

**Trip**:
The timetable entry, reused across days. The plan, not an instance. The feed hands the undated
identity as `RealtimeTripId` or `AVMSTripID`; the dated instant of a run is `tripInstanceId`.
_Avoid_: run (for undated), vehicle

**Run**:
One dated instance of a trip on the road today. What is tracked, ended, and retired.
_Avoid_: trip (for dated cases), ride

**Vehicle**:
The mark drawn for a run. A run might have none; a mark never outruns its run. Its dated identity
is the **run mark**, the key a drawn mark is followed by.
_Avoid_: vehicle (for other cars)

**RunSequence**:
What a run states about itself: its calls, one clock, the identity they refine. Never carries a
row's platform, countdown, or row id — those belong to the Departure.
_Avoid_: full trip reading, sequence (bare)

**RunReadingStore**:
The session's memory of runs: one record per run, rows and sequences kept unflattened, a record
retiring when its calls run out or age out.
_Avoid_: cache (implies rebuildable), store (bare)

**Run record key**:
The undated address a run's evidence and requests are shared under (`run:line|tripCode`). Deliberately
carries no date — see ADR-0002.
_Avoid_: run key (bare), trip key

**Run mark key**:
The dated identity a drawn mark is followed by, refined by the run's own sequence. Moves where the
record key must not.
_Avoid_: vehicle key, run key (bare)

**Board row key**:
What collapses one board's two rows for one run. Answers nothing where the feed numbered no trip,
and is no identity outside the board it was taken on.
_Avoid_: run key (bare), departure id

**Run state**:
What the record currently holds: the freshest rows and freshest sequence, each dated by its own
half. Vehicles are placed from it and every view reads the same one; a board names run ids and
displays its rows, it does not keep the run.
_Avoid_: state (bare, of the network), snapshot, cache

**Reading**:
One dated answer from the feed for one question: content plus provenance. A `…Reading` type is the
content, and the view-facing type is that reading together with its liveness — live or unavailable,
the live one being the only kind dated by the feed's clock. The question names which reading: a
board reading, a run reading (a row or its sequence, held in the run's record), a notices reading.
_Avoid_: fetch, response, snapshot, board (bare, for the view-facing type)

**Feed clock**:
The operator's clock, anchored at read time and advanced by the device. Counting and staleness
reason against it, never against the device clock alone.
_Avoid_: server time (as a re-read instant), now (bare)

**Expected departure instant**:
The one time a row is read against: the prediction when present, else schedule plus delay. One
published time per row.
_Avoid_: delay (used as the time), printed time

**Stale**:
A reading older than the cadence of the question it answers. A failed refresh is not stale; the
last answer is kept and its age stated.
_Avoid_: expired, invalid

## Lines and bundles

**Line family**:
The passenger-facing identity of a line ("S1"). Never a claim about shared running.
_Avoid_: line (bare where identity matters), route

**Line trunk**:
The S-Bahn numbering behind the same digit (S11 → S1). Numbering only.
_Avoid_: trunk (for actual shared track)

**Line bundle**:
Two families read together over an observed shared stretch, addressed by the rider
(`line/S1+S11`). A property of a corridor at one stop, never a persistent merge.
_Avoid_: merged line, group

**Shared stretch**:
The observed portion of track two families cover together: the trunk before the junction, the
branches past it.
_Avoid_: trunk (bare), shared route

**Observed network**:
The lines and stops the app has seen live at its observation posts. A line that stops running
leaves the view by itself.
_Avoid_: network (bare), active network

**Observation post**:
A fixed stop whose board is read to learn the network, not for any rider's view.
_Avoid_: monitored stop

**Line observation**:
What one family's boards are asked for: learned stops plus both directions, addressed whole.
_Avoid_: line crawl results

**farthestRunTermini**:
The ends of the farthest run observed for a family: the honest extent of its listing, where short
workings don't mislead.
_Avoid_: terminus list

## Trips and calls

**Call**:
One stop of a run's sequence, with its times and platform facts. Spelled as the provider does
(`TripCall`) — the sequence is the trip's in the feed's own words.
_Avoid_: stop (within a sequence), trip stop (as a different concept)

**Boarding call**:
The one call of a sequence a row was actually read at — the only place a row's facts may correct the
run's own account of itself.
_Avoid_: current stop, row's stop

**Sequence start / end, stated**:
What the feed says about the boundaries of a run's calls, as opposed to what is merely absent.
_Avoid_: first/last call (when citing the feed)

**Turnaround**:
The inferred join of an arrival at a terminus to the departure it turns out as; the wait is drawn.
_Avoid_: reversal, deadhead

**Ride**:
A run read on its own, for a rider aboard it, against a chosen boarding and alighting stop.
_Avoid_: active trip, journey

**Ausstieg**:
The rider-chosen get-off stop of a ride. Carried in the address, never inferred.
_Avoid_: destination (loosely), to-stop

**VehicleAccess**:
Whether a vehicle is step-free or not. An unstated third state makes it more than a boolean.
_Avoid_: accessibility flag

**Exceptional operation**:
The operator's stated diversion or replacement service state. A cancelled run teaches no route;
a diverted run does, because its published calls are the route passengers can actually use now.
_Avoid_: umleitung (bare), SEV (bare)

## Corridors and wayfinding

**StopServiceCorridor**:
The trips leaving a stop over the same first link, named by the place they head into, not by the
sign the trips carry.
_Avoid_: direction, corridor (bare)

**Corridor way**:
The enrichment of a corridor answer: termini the rider picks between, plus the places that
disambiguate them.
_Avoid_: places list

**Interchange**:
Which families a rider can change to at a stop, read from observed trip chains.
_Avoid_: connections, transfer list

**Joined portions**:
Separately addressed parts of one physical working, joined by train number and sequence
agreement — not a new run.
_Avoid_: train splitting

## The Zentrum

**Zentrum**:
The one authored concept: the curated stop list that decides what the schematic counts in. Code
reads `zentrum` even where the provider's URL segment still spells `/center`.
_Avoid_: centre, central, Hauptbahnhof (loosely)

**Zentrum membership**:
The authored list deciding which stops count as the Zentrum; membership is the only thing it
decides, and never a claim that anything listed is running.
_Avoid_: the Zentrum (for the list itself), Zentrum stop

**Zentrum calls**:
The observed membership stops one line was seen calling at.
_Avoid_: Zentrum stop list

**Schematic plan**:
The authored drawing: nodes, edges, lanes, positions. An answer, solved once; never read live.
_Avoid_: map

**Schematic reading**:
What today's runs state on the plan: vehicles, their rides, their signs.
_Avoid_: live map, state

**Node / Edge / Lane**:
The plan's atoms: one node per stop, an edge per link, a lane holding a family along a corridor.
_Avoid_: station/segment/track

## Data layer boundary

**TransitSource**:
The boundary behind which fetching, id resolution, and merging live. Views never touch a provider.
_Avoid_: API client (as an app concept), data layer

**Line**:
The passenger-facing identity of a service — its sign ("S1", "2"). Addressable, drawn, listed; the
provider states it as `servingLine.symbol`.
_Avoid_: route, train, stateless id reuse

**KvvEfa**:
The Karlsruhe transport operator's EFA feed: what is fetched and parsed.
_Avoid_: the API

**KvvTripLocator**:
The provider's five-field address for one dated trip: trip code, line, stop point, date, time.
_Avoid_: trip id (ambiguous)

**TripId, tripInstanceId, departure id**:
Three addresses at three grains: the undated trip, the dated instance, the stop-specific row.
None stands for another.
_Avoid_: id (bare)

**GTFS archive**:
The offline planned timetable that feeds the generated catalog and line colouring. Never read
live.
_Avoid_: the timetable database

## Attachment to the provider's words

Field names the provider names are kept verbatim (`trainNum`, `stopSeqCoords`, `serverTime`,
`RealtimeTripId`), even where the app's own field is renamed (`trainNumber`). Don't rename provider
spelling into the glossary's vocabulary. Where the provider is silent, the app coins — Run, Line
family, Observation post — and the coin stands until the feed names the same thing itself.

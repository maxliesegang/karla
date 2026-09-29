# A run is keyed by `line|tripCode`, with no date

A run record is keyed by the provider's own address for it, the locator's line and `tripCode`,
which is the tuple the trip endpoint is asked with. It carries no date, even though the code is not
unique over time. Measured with `npm run probe:run-identity` (6 September 2026): of 57 runs seen at
several Zentrum posts, none was named by two codes, and within one reading the codes matched the
runs one to one. But half the codes came round again the next day, on the same line at the same
minute.

A date in the key would split a run at midnight to guard against a collision a whole day away.
Lifetime separates the two instead: a record retires when its run ends (`RUN_ENDED_GRACE_MS` after
the last call), or after `RUN_READING_MAX_AGE_MS` (4 h) if its end is unknown. Both come long before
the code is reused. The dated identity a drawn mark follows is a separate key (`getRunMarkKey`).

## Consequences

Retirement is what keeps the key correct, so the lifetimes must nest, innermost first:

    board cache (30 s) < mark retention (2 min) < RUN_ENDED_GRACE_MS (10 min) < RUN_READING_MAX_AGE_MS (4 h)

A cached board that outlived its rows' records would make every stop ask for the same run again. A
drawn mark that outlived its record would vanish from the plan. `tests/trip-loading.test.ts`
asserts the order.

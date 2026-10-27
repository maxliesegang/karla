<?php
// A stop's departures or arrivals: GET ?stop=de:08212:37[&rows=20][&calls=1][&kind=arrival]
// [&lines=kvv:21005:E:R,kvv:21004:E:H]

declare(strict_types=1);

require __DIR__ . '/../lib/trias.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') fail(405, 'GET only');

$stop = param('stop', '/^de:\d{5}:\d+(:\d+){0,2}$/');
$rows = (int) param('rows', '/^([1-9]|[1-5]\d|60)$/', '20');
$calls = param('calls', '/^[01]$/', '0') === '1' ? 'true' : 'false';
$kind = param('kind', '/^(departure|arrival)$/', 'departure');
// Pool, line number, variant, then direction and timetable: kvv:21005:E:R:s26, vvs:20015::H:j26,
// ddb:920S6:C:R, sbg:67642:0:H.
$lineRef = '[a-z]{2,5}:[A-Za-z0-9]{1,8}:[A-Za-z0-9]{0,2}(:[HR](:[a-z]\d{2})?)?';
$lines = param('lines', "/^($lineRef(,$lineRef){0,15})?$/", '');

// Without an explicit `Exclude`, the provider treats the listed lines as excluded.
$lineFilter = $lines === '' ? '' : '<LineFilter>'
    . implode('', array_map(static fn ($line) => '<Line><LineRef>' . xml($line) . '</LineRef></Line>', explode(',', $lines)))
    . '<Exclude>false</Exclude></LineFilter>';

// No DepArrTime: the provider's "now" keeps the payload, and so the cache key, stable.
serve(<<<XML
    <StopEventRequest>
      <Location><LocationRef><StopPointRef>{$stop}</StopPointRef></LocationRef></Location>
      <Params>
        $lineFilter
        <NumberOfResults>$rows</NumberOfResults>
        <StopEventType>$kind</StopEventType>
        <IncludePreviousCalls>$calls</IncludePreviousCalls>
        <IncludeOnwardCalls>$calls</IncludeOnwardCalls>
        <IncludeRealtimeData>true</IncludeRealtimeData>
      </Params>
    </StopEventRequest>
    XML);

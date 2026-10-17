<?php
// A stop's departures: GET ?stop=7000037[&rows=20][&calls=1][&lines=kvv:21005:E:R,kvv:21004:E:H]

declare(strict_types=1);

require __DIR__ . '/../lib/trias.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') fail(405, 'GET only');

$stop = param('stop', '/^(\d{5,9}|de:\d{5}:\d+(:\d+){0,2})$/');
$rows = (int) param('rows', '/^([1-9]|[1-3]\d|40)$/', '20');
$calls = param('calls', '/^[01]$/', '0') === '1' ? 'true' : 'false';
$lineRef = 'kvv:\d+:[A-Z](:[HR](:s\d+)?)?';
$lines = param('lines', "/^($lineRef(,$lineRef){0,3})?$/", '');

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
        <StopEventType>departure</StopEventType>
        <IncludePreviousCalls>$calls</IncludePreviousCalls>
        <IncludeOnwardCalls>$calls</IncludeOnwardCalls>
        <IncludeRealtimeData>true</IncludeRealtimeData>
      </Params>
    </StopEventRequest>
    XML);

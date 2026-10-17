<?php
// One run's calls: GET ?journey=kvv:21005:E:R:s26:302&day=2026-10-15

declare(strict_types=1);

require __DIR__ . '/../lib/trias.php';

if ($_SERVER['REQUEST_METHOD'] !== 'GET') fail(405, 'GET only');

$journey = param('journey', '/^[a-z]+:[A-Za-z0-9:_-]{1,80}$/');
$day = param('day', '/^\d{4}-\d{2}-\d{2}$/');

serve('<TripInfoRequest>'
    . '<JourneyRef>' . xml($journey) . '</JourneyRef>'
    . '<OperatingDayRef>' . xml($day) . '</OperatingDayRef>'
    . '<Params>'
    . '<UseTimetabledDataOnly>false</UseTimetabledDataOnly>'
    . '<IncludeCalls>true</IncludeCalls>'
    . '<IncludeService>true</IncludeService>'
    . '</Params>'
    . '</TripInfoRequest>');

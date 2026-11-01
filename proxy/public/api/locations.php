<?php
// Stop search: GET ?q=Europaplatz[&rows=10], or by area: GET ?box=south,west,north,east[&rows=200]

declare(strict_types=1);

require __DIR__ . '/../lib/trias.php';
$proxyMetrics = start_proxy_metrics(isset($_GET['box']) ? 'location_area' : 'location_search');

const SEARCH_TTL_SECONDS = 3600;
const AREA_TTL_SECONDS = 86400;
/** The widest box, in degrees per side: a few kilometres, never a sweep. */
const MAX_BOX_DEGREES = 0.05;

if ($_SERVER['REQUEST_METHOD'] !== 'GET') fail(405, 'GET only');

if (isset($_GET['box'])) {
    $coordinate = '-?\d{1,3}(\.\d{1,3})?';
    $box = param('box', "/^$coordinate,$coordinate,$coordinate,$coordinate$/");
    [$south, $west, $north, $east] = array_map('floatval', explode(',', $box));
    if ($south >= $north || $west >= $east
        || $north - $south > MAX_BOX_DEGREES || $east - $west > MAX_BOX_DEGREES) {
        fail(400, 'invalid box');
    }
    $rows = (int) param('rows', '/^([1-9]\d?|1\d\d|200)$/', '200');
    serve('<LocationInformationRequest>'
        . '<InitialInput><GeoRestriction><Rectangle>'
        . "<UpperLeft><Longitude>$west</Longitude><Latitude>$north</Latitude></UpperLeft>"
        . "<LowerRight><Longitude>$east</Longitude><Latitude>$south</Latitude></LowerRight>"
        . '</Rectangle></GeoRestriction></InitialInput>'
        . "<Restrictions><Type>stop</Type><NumberOfResults>$rows</NumberOfResults></Restrictions>"
        . '</LocationInformationRequest>', AREA_TTL_SECONDS);
}

$query = preg_replace('/\s+/u', ' ', trim((string) ($_GET['q'] ?? '')));
$_GET['q'] = $query;
$query = param('q', "/^[\\p{L}\\p{N} .,'\\/()&-]{2,60}$/u");
$rows = (int) param('rows', '/^([1-9]|1\d|20)$/', '10');

serve('<LocationInformationRequest>'
    . '<InitialInput><LocationName>' . xml($query) . '</LocationName></InitialInput>'
    . "<Restrictions><Type>stop</Type><NumberOfResults>$rows</NumberOfResults><IncludePtModes>true</IncludePtModes></Restrictions>"
    . '</LocationInformationRequest>', SEARCH_TTL_SECONDS);

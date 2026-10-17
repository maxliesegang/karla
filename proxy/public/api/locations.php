<?php
// Stop search: GET ?q=Europaplatz[&rows=10]

declare(strict_types=1);

require __DIR__ . '/../lib/trias.php';

const SEARCH_TTL_SECONDS = 3600;

if ($_SERVER['REQUEST_METHOD'] !== 'GET') fail(405, 'GET only');

$query = preg_replace('/\s+/u', ' ', trim((string) ($_GET['q'] ?? '')));
$_GET['q'] = $query;
$query = param('q', "/^[\\p{L}\\p{N} .,'\\/()&-]{2,60}$/u");
$rows = (int) param('rows', '/^([1-9]|1\d|20)$/', '10');

serve('<LocationInformationRequest>'
    . '<InitialInput><LocationName>' . xml($query) . '</LocationName></InitialInput>'
    . "<Restrictions><Type>stop</Type><NumberOfResults>$rows</NumberOfResults><IncludePtModes>true</IncludePtModes></Restrictions>"
    . '</LocationInformationRequest>', SEARCH_TTL_SECONDS);

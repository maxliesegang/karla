<?php
declare(strict_types=1);

ini_set('display_errors', '0');
umask(0077);
header('Cache-Control: no-store');
header('Vary: Origin');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    http_response_code(405);
    exit;
}

$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
if (!in_array($origin, ['https://karla.app.liesegang.info', 'https://maxliesegang.github.io'], true)) {
    http_response_code(403);
    exit;
}
header("Access-Control-Allow-Origin: $origin");

if (($_SERVER['QUERY_STRING'] ?? '') !== '' || (int) ($_SERVER['CONTENT_LENGTH'] ?? 0) !== 0
    || file_get_contents('php://input', false, null, 0, 1) !== '') {
    http_response_code(400);
    exit;
}

if (($_SERVER['HTTP_DNT'] ?? '') === '1' || ($_SERVER['HTTP_SEC_GPC'] ?? '') === '1') {
    http_response_code(204);
    exit;
}

require_once __DIR__ . '/../lib/app-opens.php';

try {
    record_app_open(dirname(__DIR__, 2) . '/analytics', new DateTimeImmutable());
    http_response_code(204);
} catch (Throwable) {
    http_response_code(503);
}

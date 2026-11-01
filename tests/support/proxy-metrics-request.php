<?php
// Runs real proxy endpoints with a local cURL substitute; never opens a network connection.

declare(strict_types=1);

$request = json_decode($argv[1], true, 512, JSON_THROW_ON_ERROR);
$_GET = $request['query'] ?? [];
$_SERVER = array_merge([
    'REQUEST_METHOD' => 'GET',
    'REMOTE_ADDR' => '192.0.2.1',
    'HTTP_USER_AGENT' => 'private-test-browser',
    'HTTP_REFERER' => 'https://example.org/private-route',
], $request['server'] ?? []);
http_response_code(200);
register_shutdown_function(static function () use ($argv): void {
    global $request;
    if (isset($request['shutdownGate'])) wait_for_test_gate($request['shutdownGate']);
    file_put_contents($argv[2], (string) http_response_code());
});

function wait_for_test_gate(string $path): void
{
    file_put_contents("$path.ready", 'ready');
    do {
        clearstatcache(true, $path);
        if (is_file($path)) return;
        usleep(1000);
    } while (true);
}

function curl_init(string $url): object
{
    return new stdClass();
}

function curl_setopt_array(object $curl, array $options): bool
{
    return true;
}

function curl_exec(object $curl): string|false
{
    global $request;
    file_put_contents(__DIR__ . '/upstream-calls', "1\n", FILE_APPEND | LOCK_EX);
    if (isset($request['upstreamGate'])) wait_for_test_gate($request['upstreamGate']);
    return match ($request['upstream'] ?? 'ok') {
        'timeout', 'connection_error' => false,
        'invalid_body' => 'not XML',
        'echoed_ref' => '<?xml version="1.0"?><Trias>TESTREQUESTOR</Trias>',
        'feed_error' => '<?xml version="1.0"?><Trias><ErrorMessage>ERROR_INVALID_JOURNEY_REF</ErrorMessage></Trias>',
        default => '<?xml version="1.0"?><Trias/>',
    };
}

function curl_getinfo(object $curl, int $option): int
{
    global $request;
    return match ($request['upstream'] ?? 'ok') {
        'timeout', 'connection_error' => 0,
        'http_error' => 503,
        default => 200,
    };
}

function curl_errno(object $curl): int
{
    global $request;
    return ($request['upstream'] ?? '') === 'timeout' ? CURLE_OPERATION_TIMEDOUT : 0;
}

if ($request['rateLimited'] ?? false) {
    mkdir(__DIR__ . '/cache', 0700, true);
    $client = hash('sha256', 'TESTREQUESTOR' . $_SERVER['REMOTE_ADDR']);
    $window = intdiv(time(), 60);
    foreach ([$window, $window + 1] as $minute) {
        file_put_contents(__DIR__ . "/cache/rate-$client-$minute", '300');
    }
}

if ($request['missingRef'] ?? false) putenv('TRIAS_REQUESTOR_REF');
if (isset($request['requestReady'])) file_put_contents($request['requestReady'], 'ready');
require __DIR__ . '/public/api/' . $request['endpoint'] . '.php';

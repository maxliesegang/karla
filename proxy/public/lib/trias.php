<?php
// Shared by the endpoints: wraps a TRIAS payload with the requestor ref, posts it, and serves the
// reply gzipped from a short shared cache. The ref never appears in a response.

declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);

const TRIAS_ENDPOINT = 'https://projekte.kvv-efa.de/liesegangtrias/trias';
const UPSTREAM_TIMEOUT_SECONDS = 15;
const CACHE_TTL_SECONDS = 15;
const RATE_LIMIT_PER_MINUTE = 120;
const PRUNE_AFTER_SECONDS = 7200;

/** `proxy/` locally, the directory above the webroot on the server. */
function private_dir(): string
{
    return dirname(__DIR__, 2);
}

function fail(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: application/json');
    header('Cache-Control: no-store');
    echo json_encode(['error' => $message]);
    exit;
}

set_exception_handler(static function (Throwable $error): void {
    error_log('trias proxy: ' . $error->getMessage());
    fail(500, 'internal error');
});

function requestor_ref(): string
{
    $configPath = private_dir() . '/trias-config.php';
    $config = is_file($configPath) ? require $configPath : [];
    $ref = $config['requestorRef'] ?? getenv('TRIAS_REQUESTOR_REF') ?: '';
    if (!is_string($ref) || !preg_match('/^[A-Za-z0-9]+$/', $ref)) {
        error_log('trias proxy: requestor ref missing or malformed');
        fail(503, 'not configured');
    }
    return $ref;
}

function cache_dir(): string
{
    $dir = private_dir() . '/cache';
    if (!is_dir($dir) && !mkdir($dir, 0700, true) && !is_dir($dir)) {
        throw new RuntimeException('cannot create cache directory');
    }
    return $dir;
}

/** A fixed window per client; addresses are stored only as salted hashes. */
function enforce_rate_limit(string $salt): void
{
    $client = hash('sha256', $salt . ($_SERVER['REMOTE_ADDR'] ?? ''));
    $window = intdiv(time(), 60);
    $path = cache_dir() . "/rate-$client-$window";
    $handle = fopen($path, 'c+');
    if ($handle === false) return;
    flock($handle, LOCK_EX);
    $count = (int) stream_get_contents($handle) + 1;
    ftruncate($handle, 0);
    rewind($handle);
    fwrite($handle, (string) $count);
    fclose($handle);
    if (mt_rand(1, 100) === 1) prune_cache();
    if ($count > RATE_LIMIT_PER_MINUTE) {
        header('Retry-After: 60');
        fail(429, 'too many requests');
    }
}

function prune_cache(): void
{
    foreach (glob(cache_dir() . '/*') ?: [] as $path) {
        if (filemtime($path) < time() - PRUNE_AFTER_SECONDS) @unlink($path);
    }
}

/** Escapes a value for XML text; inputs are validated before they get here. */
function xml(string $value): string
{
    return htmlspecialchars($value, ENT_XML1 | ENT_QUOTES, 'UTF-8');
}

function envelope(string $ref, string $payload): string
{
    $now = gmdate('Y-m-d\TH:i:s\Z');
    return <<<XML
        <?xml version="1.0" encoding="UTF-8"?>
        <Trias version="1.2" xmlns="http://www.vdv.de/trias" xmlns:siri="http://www.siri.org.uk/siri">
          <ServiceRequest>
            <siri:RequestTimestamp>$now</siri:RequestTimestamp>
            <siri:RequestorRef>{$ref}</siri:RequestorRef>
            <RequestPayload>$payload</RequestPayload>
          </ServiceRequest>
        </Trias>
        XML;
}

/** Posts the payload, or `null` on any failure; upstream details are logged, never returned. */
function fetch_trias(string $ref, string $payload): ?string
{
    $curl = curl_init(TRIAS_ENDPOINT);
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => envelope($ref, $payload),
        CURLOPT_HTTPHEADER => ['Content-Type: text/xml'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_ENCODING => '',
        CURLOPT_TIMEOUT => UPSTREAM_TIMEOUT_SECONDS,
    ]);
    $body = curl_exec($curl);
    $status = curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    if (!is_string($body) || $status !== 200 || !str_starts_with(ltrim($body), '<?xml')) {
        error_log("trias proxy: upstream HTTP $status");
        return null;
    }
    if (str_contains($body, $ref)) {
        error_log('trias proxy: upstream echoed the requestor ref');
        return null;
    }
    return $body;
}

/**
 * Answers with the TRIAS reply to this payload. One upstream request per payload and TTL however
 * many clients ask; concurrent misses wait for the first.
 */
function serve(string $payload, int $ttlSeconds = CACHE_TTL_SECONDS): never
{
    $ref = requestor_ref();
    enforce_rate_limit($ref);

    $path = cache_dir() . '/reply-' . hash('sha256', $payload) . '.xml.gz';
    $fresh = static fn (): bool => is_file($path) && filemtime($path) > time() - $ttlSeconds;
    if (!$fresh()) {
        $lock = fopen("$path.lock", 'c');
        flock($lock, LOCK_EX);
        clearstatcache(true, $path);
        if (!$fresh()) {
            $body = fetch_trias($ref, $payload);
            if ($body === null) fail(502, 'upstream unavailable');
            $temporary = "$path." . getmypid();
            file_put_contents($temporary, gzencode($body, 9));
            rename($temporary, $path);
        }
        fclose($lock);
    }

    $age = time() - filemtime($path);
    header('Content-Type: application/xml; charset=utf-8');
    header('Cache-Control: public, max-age=' . max(0, $ttlSeconds - $age));
    header('Vary: Accept-Encoding');
    if (str_contains($_SERVER['HTTP_ACCEPT_ENCODING'] ?? '', 'gzip')) {
        header('Content-Encoding: gzip');
        readfile($path);
    } else {
        echo gzdecode((string) file_get_contents($path));
    }
    exit;
}

/** A query parameter matching the pattern, the default when absent, or a 400. */
function param(string $name, string $pattern, ?string $default = null): string
{
    $value = $_GET[$name] ?? $default;
    if (!is_string($value) || !preg_match($pattern, $value)) fail(400, "invalid $name");
    return $value;
}

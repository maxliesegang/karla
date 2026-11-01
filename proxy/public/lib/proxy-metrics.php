<?php
// Best-effort daily operation totals; no request parameters or client information are retained.

declare(strict_types=1);

final class ProxyMetrics
{
    private array $counts = [
        'requests' => 1,
        'cache_hits' => 0,
        'upstream_requests' => 0,
        'upstream_failures' => 0,
        'upstream_timeouts' => 0,
    ];

    public function __construct(
        private string $directory,
        private string $operation,
        private DateTimeImmutable $startedAt,
    ) {
        if (!in_array($operation, ['stop_events', 'trip_info', 'location_search', 'location_area'], true)) {
            throw new InvalidArgumentException('unknown proxy operation');
        }
    }

    public function cacheHit(): void
    {
        $this->counts['cache_hits']++;
    }

    public function upstreamRequest(): void
    {
        $this->counts['upstream_requests']++;
    }

    public function upstreamFailure(bool $timedOut = false): void
    {
        $this->counts['upstream_failures']++;
        if ($timedOut) $this->counts['upstream_timeouts']++;
    }

    public function save(int $status): void
    {
        $lock = false;
        $temporary = false;
        try {
            if (!is_dir($this->directory) && !@mkdir($this->directory, 0700, true)
                && !is_dir($this->directory)) return;

            $day = $this->startedAt->setTimezone(new DateTimeZone('Europe/Berlin'))->format('Y-m-d');
            $path = "$this->directory/$day.json";
            $lock = @fopen("$this->directory/$day.lock", 'c');
            if ($lock === false || !@flock($lock, LOCK_EX | LOCK_NB)) return;
            @chmod("$this->directory/$day.lock", 0600);

            $totals = is_file($path)
                ? json_decode(@file_get_contents($path), true, 512, JSON_THROW_ON_ERROR)
                : [];
            foreach ($this->counts as $name => $count) {
                $totals[$this->operation][$name] = ($totals[$this->operation][$name] ?? 0) + $count;
            }
            $responses = &$totals[$this->operation]['responses'];
            $responses[$status] = ($responses[$status] ?? 0) + 1;
            ksort($totals);
            $json = json_encode($totals, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
            $temporary = @tempnam($this->directory, 'metrics-');
            if ($temporary === false || @file_put_contents($temporary, $json) !== strlen($json)) return;
            @rename($temporary, $path);
        } catch (Throwable) {
            // Metrics must not change the proxy's response.
        } finally {
            if ($temporary !== false && is_file($temporary)) @unlink($temporary);
            if ($lock !== false) @fclose($lock);
        }
    }
}

function start_proxy_metrics(string $operation): ProxyMetrics
{
    $metrics = new ProxyMetrics(dirname(__DIR__, 2) . '/analytics/proxy', $operation, new DateTimeImmutable());
    register_shutdown_function(static function () use ($metrics): void {
        $error = error_get_last();
        $fatal = $error !== null && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR], true);
        $metrics->save($fatal ? 500 : (http_response_code() ?: 200));
    });
    return $metrics;
}

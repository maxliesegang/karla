<?php
// Daily totals only, stored outside the webroot and replaced under a shared lock.

declare(strict_types=1);

function record_app_open(string $directory, DateTimeImmutable $now): void
{
    if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
        throw new RuntimeException('cannot create app-open directory');
    }

    $lock = fopen("$directory/daily-opens.lock", 'c');
    if ($lock === false) throw new RuntimeException('cannot open app-open lock');
    $temporary = false;
    try {
        if (!flock($lock, LOCK_EX)) throw new RuntimeException('cannot lock app-open totals');
        $path = "$directory/daily-opens.json";
        $counts = is_file($path)
            ? json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR)
            : [];
        $day = $now->setTimezone(new DateTimeZone('Europe/Berlin'))->format('Y-m-d');
        $counts[$day] = ($counts[$day] ?? 0) + 1;
        ksort($counts);
        $json = json_encode($counts, JSON_PRETTY_PRINT | JSON_THROW_ON_ERROR) . "\n";
        $temporary = tempnam($directory, 'opens-');
        if ($temporary === false || file_put_contents($temporary, $json) !== strlen($json)) {
            throw new RuntimeException('cannot write app-open totals');
        }
        if (!rename($temporary, $path)) throw new RuntimeException('cannot replace app-open totals');
    } finally {
        if ($temporary !== false && is_file($temporary)) unlink($temporary);
        fclose($lock);
    }
}

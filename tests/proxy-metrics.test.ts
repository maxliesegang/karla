import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const run = promisify(execFile);
const disabledCurl =
  "disable_functions=curl_init,curl_setopt_array,curl_exec,curl_getinfo,curl_errno";
const stopQuery = { stop: "de:08212:37" };

async function waitForFile(path: string) {
  for (let attempt = 0; attempt < 300; attempt++) {
    if (await stat(path).catch(() => null)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for ${path}`);
}

type Counts = {
  requests: number;
  cache_hits: number;
  upstream_requests: number;
  upstream_failures: number;
  upstream_timeouts: number;
  responses: Record<string, number>;
};

async function proxy(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "karla-proxy-metrics-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const folder of ["api", "lib"]) {
    await mkdir(join(directory, "public", folder), { recursive: true });
    for (const file of await readdir(new URL(`../proxy/public/${folder}/`, import.meta.url))) {
      if (!file.endsWith(".php")) continue;
      await copyFile(
        new URL(`../proxy/public/${folder}/${file}`, import.meta.url),
        join(directory, "public", folder, file),
      );
    }
  }
  await copyFile(
    new URL("./support/proxy-metrics-request.php", import.meta.url),
    join(directory, "request.php"),
  );
  let requestNumber = 0;
  return {
    directory,
    metricsDirectory: join(directory, "analytics/proxy"),
    async request(
      endpoint = "stop-events",
      query: Record<string, string> = stopQuery,
      options: Record<string, unknown> = {},
    ) {
      const statusPath = join(directory, `status-${requestNumber++}`);
      const { stdout } = await run(
        "php",
        [
          "-d",
          disabledCurl,
          join(directory, "request.php"),
          JSON.stringify({ endpoint, query, ...options }),
          statusPath,
        ],
        { env: { ...process.env, TRIAS_REQUESTOR_REF: "TESTREQUESTOR" }, timeout: 5000 },
      );
      return { status: Number(await readFile(statusPath, "utf8")), body: stdout };
    },
    async totals() {
      const files = (await readdir(join(directory, "analytics/proxy"))).filter((file) =>
        file.endsWith(".json"),
      );
      assert.equal(files.length, 1);
      return JSON.parse(
        await readFile(join(directory, "analytics/proxy", files[0]), "utf8"),
      ) as Record<string, Counts>;
    },
    async record(instant = "2026-11-01T12:00:00Z") {
      return run(
        "php",
        [
          "-r",
          `require $argv[1];
         $metrics = new ProxyMetrics($argv[2], 'stop_events', new DateTimeImmutable($argv[3]));
         $metrics->cacheHit();
         $metrics->save(200);
         echo 'done';`,
          join(directory, "public/lib/proxy-metrics.php"),
          join(directory, "analytics/proxy"),
          instant,
        ],
        { timeout: 5000 },
      );
    },
  };
}

test("cache reuse avoids TRIAS calls and retains only operation totals", async (t) => {
  const app = await proxy(t);
  assert.equal((await app.request()).status, 200);
  assert.equal((await app.request()).status, 200);
  assert.deepEqual(await app.totals(), {
    stop_events: {
      requests: 2,
      cache_hits: 1,
      upstream_requests: 1,
      upstream_failures: 0,
      upstream_timeouts: 0,
      responses: { "200": 2 },
    },
  });
  assert.equal(await readFile(join(app.directory, "upstream-calls"), "utf8"), "1\n");
  const [file] = (await readdir(app.metricsDirectory)).filter((name) => name.endsWith(".json"));
  assert.equal((await stat(join(app.metricsDirectory, file))).mode & 0o777, 0o600);
  assert.equal((await stat(app.metricsDirectory)).mode & 0o777, 0o700);
});

test("boards, journeys, name searches and area searches have separate totals", async (t) => {
  const app = await proxy(t);
  for (const [endpoint, query] of [
    ["stop-events", stopQuery],
    ["trip-info", { journey: "kvv:21005:E:R:s26:302", day: "2026-11-01" }],
    ["locations", { q: "Europaplatz" }],
    ["locations", { box: "49.000,8.400,49.010,8.410" }],
  ] as const) {
    assert.equal((await app.request(endpoint, query)).status, 200);
  }
  const totals = await app.totals();
  assert.deepEqual(Object.keys(totals), [
    "location_area",
    "location_search",
    "stop_events",
    "trip_info",
  ]);
  for (const count of Object.values(totals)) {
    assert.equal(count.requests, 1);
    assert.equal(count.upstream_requests, 1);
    assert.equal(count.cache_hits, 0);
  }
});

test("overlapping requests share one upstream fetch and count the reused reply", async (t) => {
  const app = await proxy(t);
  const upstreamGate = join(app.directory, "release-upstream");
  const shutdownGate = join(app.directory, "release-shutdown");
  const requestReady = join(app.directory, "request-ready");
  const first = app.request("stop-events", stopQuery, { upstreamGate });
  await waitForFile(`${upstreamGate}.ready`);
  const second = app.request("stop-events", stopQuery, { shutdownGate, requestReady });
  await waitForFile(requestReady);
  await writeFile(upstreamGate, "release");
  assert.equal((await first).status, 200);
  await waitForFile(`${shutdownGate}.ready`);
  await writeFile(shutdownGate, "release");
  assert.equal((await second).status, 200);
  const totals = (await app.totals()).stop_events;
  assert.equal(totals.requests, 2);
  assert.equal(totals.cache_hits, 1);
  assert.equal(totals.upstream_requests, 1);
  assert.equal(await readFile(join(app.directory, "upstream-calls"), "utf8"), "1\n");
});

test("upstream failures include timeouts, HTTP failures and rejected replies", async (t) => {
  const app = await proxy(t);
  for (const upstream of [
    "timeout",
    "connection_error",
    "http_error",
    "invalid_body",
    "echoed_ref",
  ]) {
    assert.equal((await app.request("stop-events", stopQuery, { upstream })).status, 502);
  }
  assert.deepEqual((await app.totals()).stop_events, {
    requests: 5,
    cache_hits: 0,
    upstream_requests: 5,
    upstream_failures: 5,
    upstream_timeouts: 1,
    responses: { "502": 5 },
  });
});

test("a TRIAS error inside HTTP 200 remains a passed-through feed response", async (t) => {
  const app = await proxy(t);
  const result = await app.request("stop-events", stopQuery, { upstream: "feed_error" });
  assert.equal(result.status, 200);
  assert.match(result.body, /ERROR_INVALID_JOURNEY_REF/);
  assert.equal((await app.totals()).stop_events.upstream_failures, 0);
});

test("invalid requests and proxy configuration errors count without calling TRIAS", async (t) => {
  const app = await proxy(t);
  assert.equal((await app.request("stop-events", { stop: "invalid" })).status, 400);
  assert.equal(
    (await app.request("stop-events", stopQuery, { server: { REQUEST_METHOD: "POST" } })).status,
    405,
  );
  assert.equal((await app.request("stop-events", stopQuery, { missingRef: true })).status, 503);
  await writeFile(join(app.directory, "cache"), "not a directory");
  assert.equal((await app.request()).status, 500);
  const totals = (await app.totals()).stop_events;
  assert.equal(totals.requests, 4);
  assert.equal(totals.cache_hits, 0);
  assert.equal(totals.upstream_requests, 0);
  assert.deepEqual(totals.responses, { "400": 1, "405": 1, "500": 1, "503": 1 });
});

test("rate-limited requests never count as attempted upstream requests", async (t) => {
  const app = await proxy(t);
  assert.equal((await app.request("stop-events", stopQuery, { rateLimited: true })).status, 429);
  const totals = (await app.totals()).stop_events;
  assert.equal(totals.requests, 1);
  assert.equal(totals.upstream_requests, 0);
  assert.equal(totals.cache_hits, 0);
  assert.deepEqual(totals.responses, { "429": 1 });
});

test("busy metrics storage is skipped without waiting or changing the response", async (t) => {
  const app = await proxy(t);
  await app.request();
  const before = await app.totals();
  const [file] = (await readdir(app.metricsDirectory)).filter((name) => name.endsWith(".lock"));
  const holder = spawn("php", [
    "-r",
    `$lock = fopen($argv[1], 'c'); flock($lock, LOCK_EX); echo 'locked'; fflush(STDOUT); fgets(STDIN);`,
    join(app.metricsDirectory, file),
  ]);
  const closed = once(holder, "close");
  t.after(() => holder.kill());
  await once(holder.stdout, "data");
  try {
    assert.equal((await app.request()).status, 200);
    assert.deepEqual(await app.totals(), before);
  } finally {
    holder.stdin.end("release\n");
    await closed;
  }
});

test("broken metrics storage leaves successful replies and existing totals intact", async (t) => {
  const app = await proxy(t);
  await app.request();
  const [file] = (await readdir(app.metricsDirectory)).filter((name) => name.endsWith(".json"));
  await writeFile(join(app.metricsDirectory, file), "unreadable");
  assert.equal((await app.request()).status, 200);
  assert.equal(await readFile(join(app.metricsDirectory, file), "utf8"), "unreadable");

  await rm(app.metricsDirectory, { recursive: true });
  await writeFile(app.metricsDirectory, "not a directory");
  assert.equal((await app.request()).status, 200);
});

test("daily files follow Berlin midnight across daylight saving changes", async (t) => {
  const app = await proxy(t);
  for (const instant of [
    "2026-10-24T21:59:59Z",
    "2026-10-24T22:00:00Z",
    "2026-10-25T22:59:59Z",
    "2026-10-25T23:00:00Z",
  ]) {
    assert.equal((await app.record(instant)).stdout, "done");
  }
  for (const [day, requests] of [
    ["2026-10-24", 1],
    ["2026-10-25", 2],
    ["2026-10-26", 1],
  ] as const) {
    const totals = JSON.parse(await readFile(join(app.metricsDirectory, `${day}.json`), "utf8"));
    assert.equal(totals.stop_events.requests, requests);
  }
});

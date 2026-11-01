import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";

const run = promisify(execFile);
const server = {
  REQUEST_METHOD: "POST",
  HTTP_ORIGIN: "https://karla.app.liesegang.info",
};

async function counter(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "karla-app-opens-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "public/api"), { recursive: true });
  await mkdir(join(directory, "public/lib"), { recursive: true });
  for (const file of ["api/app-open.php", "lib/app-opens.php"]) {
    await copyFile(
      new URL(`../proxy/public/${file}`, import.meta.url),
      join(directory, "public", file),
    );
  }
  return {
    directory,
    totals: join(directory, "analytics/daily-opens.json"),
    async request(overrides: Record<string, string> = {}) {
      const { stdout, stderr } = await run("php", [
        "-r",
        `$_SERVER = json_decode($argv[1], true, 512, JSON_THROW_ON_ERROR);
         http_response_code(200);
         register_shutdown_function(static function () { echo http_response_code(); });
         require $argv[2];`,
        JSON.stringify({ ...server, ...overrides }),
        join(directory, "public/api/app-open.php"),
      ]);
      assert.equal(stderr, "");
      return Number(stdout);
    },
    async record(instant: string) {
      await run("php", [
        "-r",
        `umask(0077);
         require $argv[1];
         record_app_open($argv[2], new DateTimeImmutable($argv[3]));`,
        join(directory, "public/lib/app-opens.php"),
        join(directory, "analytics"),
        instant,
      ]);
    },
  };
}

test("concurrent app opens retain every increment and store only private daily totals", async (t) => {
  const app = await counter(t);
  const statuses = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      app.request({
        HTTP_ORIGIN: index % 2 ? server.HTTP_ORIGIN : "https://maxliesegang.github.io",
        REMOTE_ADDR: `192.0.2.${index}`,
        HTTP_USER_AGENT: "private-browser",
        HTTP_REFERER: "https://example.org/private-journey",
      }),
    ),
  );
  assert.deepEqual(statuses, Array(12).fill(204));
  const counts = JSON.parse(await readFile(app.totals, "utf8"));
  assert.equal(
    Object.values(counts).reduce((sum: number, count) => sum + Number(count), 0),
    12,
  );
  for (const day of Object.keys(counts)) assert.match(day, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual((await readdir(join(app.directory, "analytics"))).sort(), [
    "daily-opens.json",
    "daily-opens.lock",
  ]);
  assert.equal((await stat(app.totals)).mode & 0o777, 0o600);
  assert.equal((await stat(join(app.directory, "analytics"))).mode & 0o777, 0o700);
});

test("daily totals follow Berlin midnight across daylight saving changes", async (t) => {
  const app = await counter(t);
  for (const instant of [
    "2026-10-24T21:59:59Z",
    "2026-10-24T22:00:00Z",
    "2026-10-25T22:59:59Z",
    "2026-10-25T23:00:00Z",
  ]) {
    await app.record(instant);
  }
  assert.deepEqual(JSON.parse(await readFile(app.totals, "utf8")), {
    "2026-10-24": 1,
    "2026-10-25": 2,
    "2026-10-26": 1,
  });
});

test("invalid submissions and privacy signals leave no analytics files", async (t) => {
  const app = await counter(t);
  for (const [request, expected] of [
    [{ REQUEST_METHOD: "GET" }, 405],
    [{ REQUEST_METHOD: "OPTIONS" }, 405],
    [{ HTTP_ORIGIN: "" }, 403],
    [{ HTTP_ORIGIN: "https://other.example" }, 403],
    [{ QUERY_STRING: "stop=private-stop" }, 400],
    [{ CONTENT_LENGTH: "10" }, 400],
    [{ HTTP_DNT: "1" }, 204],
    [{ HTTP_SEC_GPC: "1" }, 204],
  ] as const) {
    assert.equal(await app.request(request), expected);
  }
  assert.deepEqual(await readdir(app.directory), ["public"]);
});

test("an unreadable total fails without resetting the last stored data", async (t) => {
  const app = await counter(t);
  await mkdir(join(app.directory, "analytics"));
  await writeFile(app.totals, "unreadable");
  assert.equal(await app.request(), 503);
  assert.equal(await readFile(app.totals, "utf8"), "unreadable");
});

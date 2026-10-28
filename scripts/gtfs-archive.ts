/** GTFS archives for the refresh scripts: downloaded whole, members streamed through `unzip -p`. */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

/** Downloads the archive; returns its `feed_version`. */
export async function downloadGtfsArchive(url: string, archivePath: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GTFS archive ${url}: HTTP ${response.status}`);
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
  for await (const [version] of readTable(archivePath, "feed_info.txt", ["feed_version"])) {
    if (version) return version;
  }
  throw new Error(`GTFS archive ${url}: no feed_version`);
}

type Fields = (string | undefined)[];

/** One archive member's rows, as the named columns in the order asked for. */
export const readTable = (
  archivePath: string,
  member: string,
  columns: readonly string[],
): AsyncGenerator<Fields> =>
  selectColumns(readArchiveMember(archivePath, member), columns, `GTFS ${member}`);

/** A table's rows after its header, as the named columns in the order asked for. */
export async function* selectColumns(
  rows: AsyncIterable<Fields> | Iterable<Fields>,
  columns: readonly string[],
  source: string,
): AsyncGenerator<Fields> {
  let indexes: number[] | undefined;
  for await (const fields of rows) {
    if (!indexes) {
      indexes = columns.map((column) => fields.indexOf(column));
      const missing = columns.filter((_, index) => indexes?.[index] === -1);
      if (missing.length > 0) throw new Error(`${source}: no ${missing.join(", ")}`);
      continue;
    }
    yield indexes.map((index) => fields[index]);
  }
}

/** One archive member streamed via `unzip -p` as quoted CSV. */
async function* readArchiveMember(archivePath: string, member: string): AsyncGenerator<Fields> {
  const unzip = spawn("unzip", ["-p", archivePath, member], { stdio: ["ignore", "pipe", "pipe"] });
  const failure = new Promise<never>((_, reject) => {
    unzip.on("error", (error: Error) => reject(new Error(`unzip ${member}: ${error.message}`)));
    unzip.on(
      "close",
      (code: number | null) => code && reject(new Error(`unzip ${member}: exited ${code}`)),
    );
  });
  failure.catch(() => {});

  try {
    for await (const line of createInterface({ input: unzip.stdout, crlfDelay: Infinity })) {
      // Members may start with a BOM.
      if (line) yield readFields(line.charCodeAt(0) === 0xfeff ? line.slice(1) : line);
    }
    await Promise.race([failure, Promise.resolve()]);
  } finally {
    unzip.kill();
  }
}

/** A CSV row's fields; quotes escape by doubling. */
export function readFields(line: string): Fields {
  const fields: Fields = [];
  let index = 0;
  while (index <= line.length) {
    if (line[index] === '"') {
      let value = "";
      index += 1;
      while (index < line.length) {
        if (line[index] !== '"') {
          value += line[index];
          index += 1;
        } else if (line[index + 1] === '"') {
          value += '"';
          index += 2;
        } else {
          break;
        }
      }
      fields.push(value || undefined);
      index += 2;
    } else {
      const end = line.indexOf(",", index);
      const value = line.slice(index, end === -1 ? undefined : end);
      fields.push(value || undefined);
      if (end === -1) break;
      index = end + 1;
    }
  }
  return fields;
}

/**
 * Takes the `public` qualifier off the generated migration SQL, as the second
 * half of `pnpm run db:generate`.
 *
 * WfGraph's tables are declared unqualified, so drizzle-kit leaves nearly every
 * statement unqualified too and then writes `REFERENCES "public"."workflows"` for
 * each foreign key: `public` is its stand-in for "the default schema", which for
 * WfGraph is whatever the running app's `database.schema` names. Left in, those
 * statements would look for the tables in `public` however the connection's
 * search_path is set, and the migration would fail on any other schema.
 *
 * That one qualifier is the whole of what this handles.
 * `packages/core/src/backend/lib/db/migrations-sql.test.ts` is the general guard:
 * it holds every committed statement to the table names the schema module
 * declares, so a qualifier drizzle-kit spells some other way fails the suite
 * instead of reaching a database.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../packages/core/drizzle"
);

const PUBLIC_QUALIFIER = /"public"\./g;

const names = (await readdir(MIGRATIONS_DIR)).filter((name) =>
  name.endsWith(".sql")
);

// Every rewrite is settled before any of them is written, so a surprise in the
// last file leaves the set as it was rather than half rewritten. Every file is
// read rather than only the newest, which is what makes running this twice a
// no-op.
const files = await Promise.all(
  names.map(async (name) => {
    const path = join(MIGRATIONS_DIR, name);
    const original = await readFile(path, "utf8");

    return { path, original, stripped: original.replace(PUBLIC_QUALIFIER, "") };
  })
);

const changed = files.filter((file) => file.stripped !== file.original);
await Promise.all(
  changed.map(async (file) => await writeFile(file.path, file.stripped))
);

console.log(
  changed.length === 0
    ? `No public qualifier to take off (${files.length} migrations checked)`
    : `Took the public qualifier off ${changed.length} of ${files.length} migrations`
);

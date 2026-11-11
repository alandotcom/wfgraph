/**
 * The clock PostgreSQL leases are kept on. Every lease instant a caller hands
 * in, on its own clock, is moved by that clock's offset from the database's
 * (`databaseClockOffset`) before it is written or compared, and every lease
 * instant read back for a caller is moved onto the caller's clock the same way,
 * so workers and Runs view readers whose clocks disagree agree on when a lease
 * expires. Wake times and park deadlines stay on the callers' clocks.
 */

import { sql } from "drizzle-orm";
import { Effect } from "effect";
import type { Database, DatabaseError } from "#src/backend/lib/effect/database";

/**
 * How far this process's clock may stand from the database's before lease
 * instants are moved onto the database's clock. A skew inside it is far
 * inside a lease's margin over its heartbeat, and leaving it alone keeps an
 * instant the caller computed exactly as it wrote it.
 */
const CLOCK_SKEW_TOLERANCE_MS = 1_000;

/** How long a measured clock offset is used before it is measured again. */
const CLOCK_OFFSET_TTL_MS = 60_000;

/** The offset last measured on one database, and when, on the process clock. */
const measuredOffsets = new WeakMap<
  Database["Service"],
  { offsetMs: number; measuredAt: number }
>();

/**
 * How far PostgreSQL's clock stands ahead of this process's, in milliseconds,
 * or 0 inside `CLOCK_SKEW_TOLERANCE_MS`. Measured with one `clock_timestamp()`
 * read against the midpoint of its round trip, and measured again once
 * `CLOCK_OFFSET_TTL_MS` has passed on the process clock either way.
 */
export function databaseClockOffset(
  database: Database["Service"]
): Effect.Effect<number, DatabaseError> {
  return Effect.suspend(() => {
    const cached = measuredOffsets.get(database);
    if (
      cached !== undefined &&
      Math.abs(Date.now() - cached.measuredAt) < CLOCK_OFFSET_TTL_MS
    ) {
      return Effect.succeed(cached.offsetMs);
    }
    return database.query(async (db) => {
      const sentAt = Date.now();
      const [row] = await db.execute<{ now: Date | string }>(
        sql`select clock_timestamp() as now`
      );
      const answeredAt = Date.now();
      const measured =
        row === undefined
          ? 0
          : new Date(row.now).getTime() - (sentAt + answeredAt) / 2;
      const offsetMs =
        Math.abs(measured) < CLOCK_SKEW_TOLERANCE_MS ? 0 : Math.round(measured);
      measuredOffsets.set(database, { offsetMs, measuredAt: answeredAt });
      return offsetMs;
    });
  });
}

/** `at`, an instant on the process clock, moved onto the database's clock. */
export function onDatabaseClock(at: Date, offsetMs: number): Date {
  return new Date(at.getTime() + offsetMs);
}

/** `at`, a lease instant on the database's clock, moved onto the process clock. */
export function onProcessClock(at: Date, offsetMs: number): Date {
  return new Date(at.getTime() - offsetMs);
}

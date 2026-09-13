import { Effect } from "effect";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseError } from "#src/backend/lib/effect/database";

export async function eventually<A>(
  label: string,
  read: () => Promise<A>,
  accept: (value: A) => boolean,
  timeout = 30_000
): Promise<A> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!accept(value)) {
    if (Date.now() >= deadline)
      throw new Error(
        `Timed out: ${label}; last observation: ${JSON.stringify(value)}`
      );
    // Polling reads depend on the previous observation.
    // eslint-disable-next-line no-await-in-loop
    await delay(50);
    // eslint-disable-next-line no-await-in-loop
    value = await read();
  }
  return value;
}

/** A one-shot boundary is claimed when the Effect executes, including concurrent callers. */
export function boundary() {
  const reached = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let armed = false;
  let fail = false;
  let hits = 0;
  return {
    arm(options: { fail: boolean; hold: boolean }) {
      armed = true;
      fail = options.fail;
      if (!options.hold) released.resolve();
    },
    reached: reached.promise,
    release: () => released.resolve(),
    get hits() {
      return hits;
    },
    apply<A>(
      operation: Effect.Effect<A, DatabaseError>,
      phase: "before" | "after"
    ) {
      return Effect.gen(function* () {
        if (!armed) return yield* operation;
        armed = false;
        const notify = Effect.gen(function* () {
          hits++;
          reached.resolve();
          yield* Effect.promise(() => released.promise);
          if (fail)
            return yield* new DatabaseError({
              cause: new Error("Injected repository failure"),
            });
          return undefined;
        });
        if (phase === "after") {
          const result = yield* operation;
          yield* notify;
          return result;
        }
        yield* notify;
        return yield* operation;
      });
    },
  };
}

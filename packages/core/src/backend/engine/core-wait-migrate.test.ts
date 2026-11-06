/**
 * What a Migration does to a Wait that is already parked.
 *
 * A Migration moves an open Execution to another Workflow Version while the run
 * is parked, so the body the executor calls next loads a different graph for
 * the same wait row. These cases drive that through `driveWithReplay`, which
 * calls the body again from the top on every wake, and swap the config between
 * calls. Each is declared in `core-wait-migrate.replay-cases.ts` so the replay
 * suite runners can run it on a real database too. The cases about what one park does live
 * in `core-wait.test.ts`.
 */

import { describe } from "vitest";
import { defineWaitMigrateReplayCases } from "#src/backend/engine/core-wait-migrate.replay-cases";

describe("wait node - migration to a later workflow version", () => {
  defineWaitMigrateReplayCases({});
});

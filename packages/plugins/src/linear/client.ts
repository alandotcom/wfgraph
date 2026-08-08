/**
 * Linear's SDK client construction.
 *
 * Held here so tests can `vi.spyOn` the factory: a `vi.mock` of `@linear/sdk`
 * that replaces `LinearClient` with a different shape per file leaks across
 * the suite when vitest runs with isolate:false.
 */

import { LinearClient } from "@linear/sdk";

export function createLinearClient(apiKey: string): LinearClient {
  return new LinearClient({ apiKey });
}

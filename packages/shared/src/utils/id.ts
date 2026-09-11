import { v7 as uuidv7 } from "uuid";

/**
 * Generate an id for a database record: 36 lowercase characters with hyphens,
 * the RFC 9562 UUID version 7 form.
 *
 * A UUIDv7 carries the generating millisecond in its leading bits, so two ids
 * compare as plain strings in the order they were generated. Inside one process
 * the `uuid` package also counts a sequence up while the millisecond repeats,
 * which extends that order to ids minted in the same millisecond. Two processes
 * seed their own sequences at random, so ids from different processes within one
 * millisecond can compare in either order.
 */
export function generateId(): string {
  return uuidv7();
}

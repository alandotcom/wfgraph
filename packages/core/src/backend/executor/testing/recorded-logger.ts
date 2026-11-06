/**
 * A host `logger` that keeps every record the bridge hands it, so a case can
 * read the runner's records back by message. The bridge prefixes each message
 * with its category in brackets, which `find` leaves out of the comparison.
 */

type Kept = { message: string; properties: unknown };

export function recordedLogger() {
  const records: Kept[] = [];
  const keep = (message: unknown, properties: unknown) => {
    records.push({ message: String(message), properties });
  };
  return {
    logger: { info: keep, warn: keep, error: keep },
    find: (message: string): Kept[] =>
      records.filter((record) => record.message.endsWith(`] ${message}`)),
  };
}

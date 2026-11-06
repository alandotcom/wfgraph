/**
 * How the executor's wall-clock cases wait: for a fixed time, or for the
 * database to reach a state, polling until it does or `REACHED_WITHIN_MS`
 * passes.
 */

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * How long a case waits for the database to reach a state before it fails.
 * Every wait ends as soon as the state is reached, so the bound only has to
 * outlast a loaded machine.
 */
export const REACHED_WITHIN_MS = 10_000;

/** Resolves once `reached` answers true, polling every 10 ms, or rejects. */
export async function waitUntil(
  reached: () => boolean | Promise<boolean>,
  what: string
): Promise<void> {
  const giveUpAt = Date.now() + REACHED_WITHIN_MS;
  // eslint-disable-next-line eslint/no-await-in-loop -- one check per tick until `reached` holds
  while (!(await reached())) {
    if (Date.now() > giveUpAt) {
      throw new Error(`${what} within ${REACHED_WITHIN_MS} ms`);
    }
    // eslint-disable-next-line eslint/no-await-in-loop -- one check per tick until `reached` holds
    await sleep(10);
  }
}

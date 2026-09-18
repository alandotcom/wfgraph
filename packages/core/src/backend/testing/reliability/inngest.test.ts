import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  InngestStartupFailure,
  reserveInngestPorts,
  startInngest,
} from "#src/backend/testing/reliability/inngest";

test("parallel runners reserve disjoint port blocks", async () => {
  const reservations = await Promise.all(
    Array.from({ length: 8 }, () => reserveInngestPorts({ firstBlock: 0 }))
  );
  try {
    const ports = reservations.flatMap((reservation) => reservation.ports);
    expect(new Set(ports).size).toBe(ports.length);
    for (const reservation of reservations)
      expect(reservation.ports).toEqual([
        reservation.ports[0],
        reservation.ports[0] + 1,
        reservation.ports[0] + 2,
        reservation.ports[0] + 3,
      ]);
  } finally {
    await Promise.all(reservations.map((reservation) => reservation.release()));
  }
});

test("repeated release does not remove a reassigned lease", async () => {
  const first = await reserveInngestPorts({ firstBlock: 0 });
  const block = (first.ports[0] - 10_000) / 4;
  await first.release();
  const second = await reserveInngestPorts({ firstBlock: block });
  let third: Awaited<ReturnType<typeof reserveInngestPorts>> | undefined;
  try {
    expect(second.ports).toEqual(first.ports);
    await first.release();
    third = await reserveInngestPorts({ firstBlock: block });
    expect(third.ports).not.toEqual(second.ports);
  } finally {
    await Promise.all([second.release(), third?.release()]);
  }
});

test("health timeout preserves output through process shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inngest-startup-test-"));
  try {
    const binary = join(directory, "fixture.cjs");
    await writeFile(
      binary,
      `#!${process.execPath}
process.stdout.write("starting fixture\\n");
process.stderr.write("startup diagnostic\\n");
process.on("SIGTERM", () => {
  process.stdout.write("shutdown diagnostic\\n", () => process.exit(0));
});
setInterval(() => {}, 1000);
`,
      { mode: 0o755 }
    );
    const failure = await startInngest(directory, {
      binary,
      timeoutMs: 2000,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InngestStartupFailure);
    if (!(failure instanceof InngestStartupFailure))
      throw new Error("Expected startup failure");
    expect(failure.cause).toMatchObject({
      message: expect.stringContaining("Timed out: Inngest health"),
    });
    const logs = failure.logs.join("");
    expect(logs).toContain("starting fixture");
    expect(logs).toContain("startup diagnostic");
    expect(logs).toContain("shutdown diagnostic");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exhausted port retries retain diagnostics from every attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "inngest-startup-test-"));
  try {
    const binary = join(directory, "fixture.cjs");
    await writeFile(
      binary,
      `#!${process.execPath}
process.stderr.write("bind: address already in use\\n", () => process.exit(1));
`,
      { mode: 0o755 }
    );
    const failure = await startInngest(directory, { binary }).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(InngestStartupFailure);
    if (!(failure instanceof InngestStartupFailure))
      throw new Error("Expected startup failure");
    const logs = failure.logs.join("");
    for (const attempt of [1, 2, 3])
      expect(logs).toContain(`Inngest startup attempt ${attempt}`);
    expect(logs.match(/bind: address already in use/g)).toHaveLength(3);
    expect(logs).not.toContain("Inngest startup attempt 4");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

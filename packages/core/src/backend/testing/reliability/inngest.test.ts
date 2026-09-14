import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  InngestStartupFailure,
  startInngest,
} from "#src/backend/testing/reliability/inngest";

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

import { execFileSync, spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

console.log('CLOCK_PROBE_EVENT {"phase":"suite-start"}');
const child = spawn(
  process.execPath,
  [
    "node_modules/vitest/vitest.mjs",
    "run",
    "--config",
    "vitest.reliability.config.ts",
    "--reporter=default",
    "--reporter=json",
    "--outputFile=vitest-results.json",
  ],
  { stdio: "inherit", env: { ...process.env, CI: "1", NO_COLOR: "1" } }
);
const result = await new Promise<{
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>((done, reject) => {
  child.once("error", reject);
  child.once("exit", (exitCode, signal) => done({ exitCode, signal }));
});
console.log(
  `CLOCK_PROBE_EVENT ${JSON.stringify({ phase: "suite-end", ...result })}`
);
if (result.signal) console.error(execFileSync("dmesg", { encoding: "utf8" }));
const files = ["vitest-results.json"];
try {
  files.push(
    ...(await readdir("test-results/reliability")).map(
      (name) => `test-results/reliability/${name}`
    )
  );
} catch {
  // Successful campaigns do not create failure artifacts.
}
for (const path of files) {
  try {
    // Serial is the guest's only output channel; the host saves each artifact.
    // eslint-disable-next-line no-await-in-loop
    const content = await readFile(path, "utf8");
    console.log(`CLOCK_SUITE_ARTIFACT ${JSON.stringify({ path, content })}`);
  } catch (error) {
    console.error(`Cannot export ${path}: ${String(error)}`);
    process.exitCode = 1;
  }
}
if (result.exitCode === 0 && !process.exitCode) {
  console.log('CLOCK_PROBE_EVENT {"phase":"complete"}');
} else {
  process.exitCode = 1;
}

import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { prepareFullSuite } from "./full-suite.ts";
import { build } from "esbuild";

const workload = process.argv[3] ?? "probe";
if (!["probe", "reliability"].includes(workload))
  throw new Error("Expected probe or reliability workload");
const memoryMb =
  process.env.VM_MEMORY_MB ?? (workload === "reliability" ? "4096" : "2048");
const selectedMode = process.argv[2] ?? "both";
if (!["both", "baseline", "accelerated"].includes(selectedMode)) {
  throw new Error("Expected baseline, accelerated, or both");
}
const directory = resolve(
  "test-results/clock-experiment",
  new Date().toISOString().replaceAll(":", "-")
);
const work = resolve(directory, "work");
await mkdir(work, { recursive: true });
if (workload === "reliability") {
  await prepareFullSuite(work);
} else
  await build({
    entryPoints: [
      "packages/core/src/backend/testing/accelerated-time/probe.ts",
    ],
    outfile: resolve(work, "probe.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire as clockCreateRequire } from "node:module"; const require = clockCreateRequire(import.meta.url);',
    },
  });

const measurements: Array<{
  mode: string;
  success: boolean;
  hostElapsedMs: number;
  intervalsMs: Record<string, number>;
}> = [];
const modes =
  selectedMode === "both" ? ["baseline", "accelerated"] : [selectedMode];
for (const mode of modes) {
  const name = `wfgraph-clock-${crypto.randomUUID()}`;
  const started = performance.now();
  const events: Array<{ hostElapsedMs: number; line: string }> = [];
  const artifacts: string[] = [];
  let output = "";
  let pending = "";
  let timedOut = false;
  let interrupted = false;
  const child = spawn(
    "sh",
    ["scripts/experiments/accelerated-time/vm/run.sh", mode, work],
    {
      env: { ...process.env, VM_CONTAINER_NAME: name, VM_MEMORY_MB: memoryMb },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  const collect = (data: Buffer) => {
    const chunk = data.toString();
    output += chunk;
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("CLOCK_SUITE_ARTIFACT ")) {
        artifacts.push(line.slice("CLOCK_SUITE_ARTIFACT ".length));
      }
      if (
        line.includes("CLOCK_PROBE_EVENT ") ||
        line.includes("VM_READY") ||
        line.includes("VM_PROBE_EXIT=")
      ) {
        const hostElapsedMs = performance.now() - started;
        events.push({ hostElapsedMs, line: line.trim() });
        process.stdout.write(
          `[${mode} ${(hostElapsedMs / 1000).toFixed(2)}s host] ${line.trim()}\n`
        );
      }
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  const stopContainer = () => {
    const stop = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
    stop.on("error", (error) =>
      process.stderr.write(`Container cleanup: ${String(error)}\n`)
    );
    return new Promise<void>((done) => stop.once("close", () => done()));
  };
  const interrupt = () => {
    interrupted = true;
    void stopContainer();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const deadline = setTimeout(
    () => {
      timedOut = true;
      // This name belongs only to this run, including any guest grandchildren.
      void stopContainer();
    },
    workload === "reliability" ? 600_000 : 240_000
  );
  // Each mode gets the machine to itself for a meaningful wall-clock comparison.
  // eslint-disable-next-line no-await-in-loop
  const exitCode = await new Promise<number | null>((done, reject) => {
    child.once("error", reject);
    child.once("close", (code) => done(code));
  }).finally(async () => {
    clearTimeout(deadline);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await stopContainer();
  });
  // Preserve the serial transcript even if a malformed artifact cannot be decoded.
  // eslint-disable-next-line no-await-in-loop
  await writeFile(resolve(directory, `${mode}.log`), output);
  let suitePassed = workload !== "reliability";
  let artifactError: string | undefined;
  try {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(
      artifacts.map(async (serialized) => {
        const artifact = JSON.parse(serialized);
        if (
          typeof artifact.path !== "string" ||
          typeof artifact.content !== "string"
        ) {
          throw new Error("Invalid guest artifact");
        }
        await writeFile(
          resolve(directory, `${mode}-${basename(artifact.path)}`),
          artifact.content
        );
        if (artifact.path === "vitest-results.json") {
          const report = JSON.parse(artifact.content);
          suitePassed =
            report.success === true &&
            report.numTotalTests === 6 &&
            report.numPassedTests === 6 &&
            report.numFailedTests === 0 &&
            report.numPendingTests === 0;
        }
      })
    );
  } catch (error) {
    artifactError = String(error);
  }
  const success =
    suitePassed &&
    !artifactError &&
    exitCode === 0 &&
    !timedOut &&
    !interrupted &&
    output.includes('"phase":"complete"') &&
    output.includes("VM_PROBE_EXIT=0");
  // These are serial-console receipt intervals, not instrumented host CPU timings.
  const intervalsMs: Record<string, number> = {};
  for (const phase of ["primitive", "sleep", "lease", "suite"]) {
    const firstLabel =
      phase === "primitive" || phase === "suite"
        ? `${phase}-start`
        : `${phase}-before`;
    const lastLabel =
      phase === "primitive" || phase === "suite"
        ? `${phase}-end`
        : `${phase}-after`;
    const first = events.find((event) =>
      event.line.includes(`"phase":"${firstLabel}"`)
    );
    const last = events.find((event) =>
      event.line.includes(`"phase":"${lastLabel}"`)
    );
    if (first && last)
      intervalsMs[phase] = last.hostElapsedMs - first.hostElapsedMs;
  }
  const result = {
    mode,
    workload,
    memoryMb,
    shift: process.env.VM_ICOUNT_SHIFT ?? "3",
    exitCode,
    timedOut,
    interrupted,
    artifactError,
    intervalsMs,
    success,
    hostElapsedMs: performance.now() - started,
    events,
  };
  // eslint-disable-next-line no-await-in-loop
  await writeFile(
    resolve(directory, `${mode}.json`),
    JSON.stringify(result, null, 2)
  );
  process.stdout.write(
    `${mode}: ${success ? "PASS" : "FAIL"}; evidence: ${directory}\n`
  );
  measurements.push({
    mode,
    success,
    hostElapsedMs: result.hostElapsedMs,
    intervalsMs,
  });
  if (!success) process.exitCode = 1;
  if (interrupted) break;
}

const baseline = measurements.find((result) => result.mode === "baseline");
const accelerated = measurements.find(
  (result) => result.mode === "accelerated"
);
if (baseline?.success && accelerated?.success) {
  const comparison = {
    totalHostSpeedup: baseline.hostElapsedMs / accelerated.hostElapsedMs,
    intervalSpeedups:
      workload === "reliability"
        ? { suite: baseline.intervalsMs.suite / accelerated.intervalsMs.suite }
        : {
            primitive:
              baseline.intervalsMs.primitive /
              accelerated.intervalsMs.primitive,
            sleep: baseline.intervalsMs.sleep / accelerated.intervalsMs.sleep,
            lease: baseline.intervalsMs.lease / accelerated.intervalsMs.lease,
          },
    measurements,
    note: "Single paired observation; intervals include serial output delivery. Correctness PASS does not imply a speedup.",
  };
  await writeFile(
    resolve(directory, "comparison.json"),
    JSON.stringify(comparison, null, 2)
  );
  process.stdout.write(
    `Host-observed comparison: ${JSON.stringify(comparison)}\n`
  );
}

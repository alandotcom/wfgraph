import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as fc from "fast-check";
import { test } from "vitest";
import {
  checkScenarios,
  withCleanup,
  type ScenarioCheck,
} from "#src/backend/testing/reliability/campaign";
import {
  createHost,
  HostSetupFailure,
  type Backend,
  type ReliabilityHost,
} from "#src/backend/testing/reliability/host";

function integer(name: string, fallback: number) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`${name} must be an integer`);
  return number;
}
function backends(): Backend[] {
  const selected = process.env.WFGRAPH_RELIABILITY_BACKEND ?? "all";
  if (selected === "all") return ["sqlite", "postgres"];
  if (selected === "sqlite" || selected === "postgres") return [selected];
  throw new Error(
    "WFGRAPH_RELIABILITY_BACKEND must be all, sqlite, or postgres"
  );
}
type FailureEvidence = Record<string, unknown>;
type Scenario<S> = (host: ReliabilityHost, value: S) => Promise<void>;

async function captureSnapshot(host: ReliabilityHost): Promise<unknown> {
  try {
    return await host.snapshot();
  } catch (error) {
    return { error: String(error) };
  }
}

async function runScenario<S>(input: {
  backend: Backend;
  value: S;
  scenario: Scenario<S>;
  evidence: Map<string, FailureEvidence>;
}) {
  const scenarioKey = JSON.stringify(input.value);
  let host: ReliabilityHost | undefined;

  try {
    await withCleanup(
      async () => {
        host = await createHost(input.backend);
        return host;
      },
      async (resource) => {
        try {
          await input.scenario(resource, input.value);
        } catch (error) {
          // Read persisted state before cleanup closes the database.
          input.evidence.set(scenarioKey, {
            error: String(error),
            persisted: await captureSnapshot(resource),
            ledger: resource.ledger,
            applicationLogs: resource.logs,
            runtimeLogs: resource.runtime.logs,
          });
          throw error;
        }
      }
    );
  } catch (error) {
    // Setup and cleanup can fail too. Keep any earlier scenario snapshot.
    input.evidence.set(scenarioKey, {
      ...input.evidence.get(scenarioKey),
      setup: error instanceof HostSetupFailure ? error.evidence : undefined,
      error: String(error),
      ledger: host?.ledger,
      applicationLogs: host?.logs,
      runtimeLogs: host?.runtime.logs,
    });
    throw error;
  }
}

async function writeFailureArtifact(input: {
  name: string;
  backend: Backend;
  result: ScenarioCheck;
  evidence: FailureEvidence | undefined;
}): Promise<Error> {
  const { name, backend, evidence } = input;
  const { details, reproduced, interrupted } = input.result;
  const path = resolve(
    "test-results/reliability",
    `${name.replaceAll(/[^a-z0-9]+/gi, "-")}-${backend}-${Date.now()}.json`
  );
  await mkdir(resolve("test-results/reliability"), { recursive: true });
  const replay = `WFGRAPH_RELIABILITY_BACKEND=${backend} WFGRAPH_RELIABILITY_SEED=${details.seed} WFGRAPH_RELIABILITY_PATH='${details.counterexamplePath ?? ""}' pnpm test:reliability -t '${name}'`;
  await writeFile(
    path,
    JSON.stringify(
      {
        name,
        backend,
        revision:
          process.env.WFGRAPH_RELIABILITY_REVISION ??
          execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
        seed: details.seed,
        path: details.counterexamplePath,
        counterexample: details.counterexample,
        interrupted,
        reproduced,
        numShrinks: details.numShrinks,
        replay,
        evidence,
      },
      null,
      2
    )
  );

  return new Error(
    `Reliability property failed. Artifact: ${path}\nReplay: ${replay}`,
    { cause: details.errorInstance }
  );
}

export function reliabilityProperty<S>(
  name: string,
  arbitrary: fc.Arbitrary<S>,
  examples: S[],
  scenario: Scenario<S>
) {
  for (const backend of backends()) {
    test(`${name} [${backend}]`, async () => {
      const evidence = new Map<string, FailureEvidence>();
      const numRuns = integer("WFGRAPH_RELIABILITY_RUNS", 5);
      if (numRuns < 1) {
        throw new Error("WFGRAPH_RELIABILITY_RUNS must be positive");
      }

      const result = await checkScenarios({
        arbitrary,
        execute: (value) => runScenario({ backend, value, scenario, evidence }),
        parameters: {
          // fast-check counts fixed examples toward numRuns.
          numRuns: numRuns + examples.length,
          examples: examples.map((value): [S] => [value]),
          seed: integer("WFGRAPH_RELIABILITY_SEED", Date.now() | 0),
          path: process.env.WFGRAPH_RELIABILITY_PATH ?? "",
        },
      });
      if (!result.details.failed) return;

      const counterexample = result.details.counterexample;
      const failedScenario = Array.isArray(counterexample)
        ? counterexample[0]
        : undefined;
      throw await writeFailureArtifact({
        name,
        backend,
        result,
        evidence: evidence.get(JSON.stringify(failedScenario)),
      });
    });
  }
}

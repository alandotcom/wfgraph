import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import * as fc from "fast-check";
import { expect, test } from "vitest";
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
import {
  GROUP_LAYOUTS,
  type GroupLayout,
} from "#src/backend/testing/reliability/groups";

function integer(name: string, fallback: number) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number))
    throw new Error(`${name} must be an integer`);
  return number;
}
/** The backends `WFGRAPH_RELIABILITY_BACKEND` selects, both by default. */
export function backends(): Backend[] {
  const selected = process.env.WFGRAPH_RELIABILITY_BACKEND ?? "all";
  if (selected === "all") return ["sqlite", "postgres"];
  if (selected === "sqlite" || selected === "postgres") return [selected];
  throw new Error(
    "WFGRAPH_RELIABILITY_BACKEND must be all, sqlite, or postgres"
  );
}
type RunEvidence = Record<string, unknown>;
/** What a failed case left behind, with one entry per layout when the property compares layouts. */
type FailureEvidence = RunEvidence & {
  layouts?: Partial<Record<GroupLayout, RunEvidence>> | undefined;
};

/**
 * Merges `entry` into the evidence kept for `value`, under `layout` when one is
 * given, so a later write for the same case adds to what an earlier one kept.
 */
function addEvidence(input: {
  evidence: Map<string, FailureEvidence>;
  value: unknown;
  layout?: GroupLayout | undefined;
  entry: RunEvidence;
}) {
  const key = JSON.stringify(input.value);
  const current = input.evidence.get(key) ?? {};
  if (input.layout === undefined) {
    input.evidence.set(key, { ...current, ...input.entry });
    return;
  }
  input.evidence.set(key, {
    ...current,
    layouts: {
      ...current.layouts,
      [input.layout]: { ...current.layouts?.[input.layout], ...input.entry },
    },
  });
}
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
  /** The Group layout this host runs, for a property that compares layouts. */
  layout?: GroupLayout | undefined;
}) {
  let host: ReliabilityHost | undefined;
  const record = (entry: RunEvidence) =>
    addEvidence({
      evidence: input.evidence,
      value: input.value,
      layout: input.layout,
      entry,
    });

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
          record({ persisted: await captureSnapshot(resource) });
          throw error;
        }
      }
    );
  } catch (error) {
    // Setup and cleanup can fail too. Keep any earlier scenario snapshot.
    record({
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
        revision: execFileSync("git", ["rev-parse", "HEAD"], {
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

type PropertyOptions = {
  /** The environment variable that sets the generated case count. */
  runsVariable?: string | undefined;
  defaultRuns?: number | undefined;
};

export function reliabilityProperty<S>(
  name: string,
  arbitrary: fc.Arbitrary<S>,
  examples: S[],
  scenario: Scenario<S>
) {
  defineProperty(name, arbitrary, examples, {}, (input) =>
    runScenario({ ...input, scenario })
  );
}

/**
 * A property whose every case runs once per Group layout, each on a fresh host
 * against the same backend. `scenario` asserts the explicit expected outcome for
 * its layout and returns an observation of what the run did. The grouped
 * observations must then equal the ungrouped one, so a Group that changes what
 * a run executes fails even when each layout meets its own expectations.
 */
export function groupLayoutProperty<S, O>(
  name: string,
  arbitrary: fc.Arbitrary<S>,
  examples: S[],
  scenario: (
    host: ReliabilityHost,
    value: S,
    layout: GroupLayout
  ) => Promise<O>,
  options: PropertyOptions = {}
) {
  defineProperty(name, arbitrary, examples, options, async (input) => {
    const observations = new Map<GroupLayout, O>();
    // The logs of each layout that passed. They join the evidence only when the
    // case fails, since a failure or a mismatch is read against every layout.
    // The arrays are the host's own, so entries written while it closes arrive.
    const passedRuns = new Map<GroupLayout, RunEvidence>();
    const keepPassedRuns = () => {
      for (const [layout, entry] of passedRuns)
        addEvidence({
          evidence: input.evidence,
          value: input.value,
          layout,
          entry,
        });
    };
    // Sequential, so the hosts of one case never compete for the machine.
    for (const layout of GROUP_LAYOUTS) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await runScenario({
          ...input,
          layout,
          scenario: async (host, value) => {
            observations.set(layout, await scenario(host, value, layout));
            passedRuns.set(layout, {
              ledger: host.ledger,
              applicationLogs: host.logs,
              runtimeLogs: host.runtime.logs,
            });
          },
        });
      } catch (error) {
        keepPassedRuns();
        throw error;
      }
    }
    const ungrouped = observations.get("ungrouped");
    for (const layout of GROUP_LAYOUTS) {
      try {
        expect(
          observations.get(layout),
          `the ${layout} layout ran differently from the ungrouped graph`
        ).toEqual(ungrouped);
      } catch (error) {
        keepPassedRuns();
        addEvidence({
          evidence: input.evidence,
          value: input.value,
          entry: {
            mismatchedLayout: layout,
            observations: Object.fromEntries(observations),
          },
        });
        throw error;
      }
    }
  });
}

function defineProperty<S>(
  name: string,
  arbitrary: fc.Arbitrary<S>,
  examples: S[],
  options: PropertyOptions,
  execute: (input: {
    backend: Backend;
    value: S;
    evidence: Map<string, FailureEvidence>;
  }) => Promise<void>
) {
  const runsVariable = options.runsVariable ?? "WFGRAPH_RELIABILITY_RUNS";
  for (const backend of backends()) {
    test(`${name} [${backend}]`, async () => {
      const evidence = new Map<string, FailureEvidence>();
      const numRuns = integer(runsVariable, options.defaultRuns ?? 5);
      if (numRuns < 1) {
        throw new Error(`${runsVariable} must be positive`);
      }

      const result = await checkScenarios({
        arbitrary,
        execute: (value) => execute({ backend, value, evidence }),
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

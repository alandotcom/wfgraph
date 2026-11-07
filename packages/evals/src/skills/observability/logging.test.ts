/**
 * Task check for the wfgraph-core/observability skill, logging half: a host
 * that already configures LogTape for its own categories also receives
 * Workflow Graph's records. Workflow Graph writes every record under the
 * `wfgraph` category and configures nothing itself, so the developer task is a
 * sink for that category inside the host's one LogTape configuration.
 *
 * `expectBothStreams` is the grader. It runs against the configuration the
 * skill recommends, and against the two mistakes it warns about, which it must
 * reject: a configuration that never names `wfgraph`, and the `logger` option
 * passed on top of the host's own configuration, which replaces it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { configure, getLogger, type LogRecord, reset } from "@logtape/logtape";
import { trustWfGraphUpstream, type WfGraphLogger } from "@wfgraph/core";
import { openHost, rest } from "#src/skills/host";

/** The host application's own LogTape category. */
const HOST_CATEGORY = "clinic-app";

/** Records two in-memory sinks received: Workflow Graph's and the host's. */
type Streams = { wfgraph: LogRecord[]; host: LogRecord[] };

/**
 * Configures LogTape the way a host with its own logging does: one
 * configuration for the process, with a sink per category. `categories`
 * lists which categories get a logger entry.
 */
async function configureHostLogging(
  categories: ReadonlyArray<"wfgraph" | typeof HOST_CATEGORY>
): Promise<Streams> {
  const streams: Streams = { wfgraph: [], host: [] };
  await configure({
    reset: true,
    sinks: {
      wfgraph: (record) => void streams.wfgraph.push(record),
      host: (record) => void streams.host.push(record),
    },
    loggers: categories.map((category) => ({
      category,
      sinks: [category === "wfgraph" ? "wfgraph" : "host"],
      lowestLevel: "info" as const,
    })),
  });
  return streams;
}

// LogTape's configuration is process-wide, and the test workers share one
// module graph across files, so every case leaves LogTape unconfigured.
afterEach(async () => {
  await reset();
});

/**
 * Opens an app, serves one API request, and has the host log one line of its
 * own after Workflow Graph started.
 */
async function exerciseHost(logger?: WfGraphLogger): Promise<void> {
  await using app = await openHost({ auth: trustWfGraphUpstream(), logger });
  const response = await rest(app, { method: "GET", path: "/workflows" });
  expect(response.status).toBe(200);
  getLogger([HOST_CATEGORY]).info("Clinic app ready");
}

/**
 * The grader. It asserts that Workflow Graph's start-up record and its record
 * for the API request reached the sink for the `wfgraph` category, with the
 * request's fields grouped under `http`, and that the host's own record still
 * reached the host's sink.
 */
function expectBothStreams(streams: Streams): void {
  const assembled = streams.wfgraph.find(
    (record) =>
      record.category.join(".") === "wfgraph.extensions" &&
      String(record.message[0]).startsWith("Extension surface assembled")
  );
  expect(assembled, "no wfgraph start-up record").toBeDefined();

  const request = streams.wfgraph.find(
    (record) => record.category.join(".") === "wfgraph.http"
  );
  expect(request?.properties).toMatchObject({
    http: { method: "GET", status: 200 },
  });

  expect(
    streams.host.map((record) => record.message.join("")),
    "the host's own record did not arrive"
  ).toContain("Clinic app ready");
}

describe("wfgraph-core/observability task check: logging", () => {
  it("delivers Workflow Graph's records to a wfgraph sink beside the host's own categories", async () => {
    const streams = await configureHostLogging(["wfgraph", HOST_CATEGORY]);
    await exerciseHost();
    expectBothStreams(streams);
  });

  // Mistake one: the host configures LogTape for its own categories alone.
  // Workflow Graph's records have no sink and are dropped.
  it("rejects a configuration with no sink for the wfgraph category", async () => {
    const streams = await configureHostLogging([HOST_CATEGORY]);
    await exerciseHost();
    expect(() => expectBothStreams(streams)).toThrow(
      "no wfgraph start-up record"
    );
  });

  // Mistake two: the host keeps its own configuration and also passes the
  // `logger` option. The option installs a LogTape configuration of its own
  // and replaces the host's, so the host's category goes silent.
  it("rejects the logger option on top of the host's own configuration", async () => {
    const streams = await configureHostLogging([HOST_CATEGORY]);
    const bridged: string[] = [];
    const record = (...args: unknown[]) => void bridged.push(String(args[0]));
    await exerciseHost({ info: record, warn: record, error: record });

    // The option did deliver Workflow Graph's records, to the bridge.
    expect(bridged.some((line) => line.startsWith("[wfgraph."))).toBe(true);
    expect(() => expectBothStreams(streams)).toThrow();
    expect(streams.host).toEqual([]);
  });
});

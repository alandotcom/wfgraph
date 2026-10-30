import { configureSync, inspectLogger, resetSync } from "@logtape/logtape";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loggerConfigs, renderLogMessage } from "#src/backend/lib/log-config";

// Back to unconfigured, which is logtape's own default and what every other
// file in this worker expects: the suite shares one module graph.
afterEach(() => {
  resetSync();
  vi.restoreAllMocks();
});

describe("renderLogMessage", () => {
  it("fills placeholders, rendering a bigint as its digits", () => {
    expect(
      renderLogMessage([
        "took ",
        BigInt(12),
        " of ",
        { limit: BigInt(40) },
        " bytes",
      ])
    ).toBe('took 12 of {"limit":"40"} bytes');
  });
});

describe("loggerConfigs", () => {
  it("delivers a meta logger record to the sink once", () => {
    configureSync({
      sinks: { sink: () => undefined },
      loggers: loggerConfigs("sink", "info"),
    });

    const inspection = inspectLogger(["logtape", "meta"], { level: "error" });

    expect(inspection.sinkPaths).toHaveLength(1);
  });
});

describe("warnWhenLoggingUnconfigured", () => {
  // The notice is once per process, so each case imports a fresh copy of the
  // module that holds that flag.
  async function freshWarn(): Promise<() => void> {
    vi.resetModules();
    const module = await import("#src/backend/lib/log-config");
    return module.warnWhenLoggingUnconfigured;
  }

  it("warns when a host configured logtape without a wfgraph sink", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const warnWhenLoggingUnconfigured = await freshWarn();
    configureSync({
      sinks: { sink: () => undefined },
      loggers: [
        { category: "host", sinks: ["sink"] },
        { category: "logtape", sinks: ["sink"], lowestLevel: "error" },
      ],
    });

    warnWhenLoggingUnconfigured();

    expect(warn).toHaveBeenCalledOnce();
  });

  it("stays quiet when the wfgraph category reaches a sink", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const warnWhenLoggingUnconfigured = await freshWarn();
    configureSync({
      sinks: { sink: () => undefined },
      loggers: loggerConfigs("sink", "info"),
    });

    warnWhenLoggingUnconfigured();

    expect(warn).not.toHaveBeenCalled();
  });
});

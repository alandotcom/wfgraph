import { describe, expect, it } from "vitest";
import {
  DEFAULT_WAIT_TIMEOUT,
  readWaitConfig,
  readWaitSubscriptions,
  waitValueKeysNotIn,
  waitValueTargetsFor,
} from "./wait-subscription";

/** A Wait node's config bag, which always carries the action's own keys too. */
function waitConfig(config: Record<string, unknown>) {
  return { actionType: "Wait", ...config };
}

describe("readWaitConfig", () => {
  // Absence and "delay" mean the same thing to a builder: the selector opens on
  // "Wait for time" and only a deliberate choice writes the key.
  it("reads an absent mode as a delay", () => {
    const read = readWaitConfig(waitConfig({ waitDuration: "1h" }));

    expect(read.valid).toBe(true);
    if (read.valid) {
      expect(read.waitMode).toBe("delay");
      expect(read.config.waitDuration).toBe("1h");
    }
  });

  it("reads the subscriptions an event wait names", () => {
    const read = readWaitConfig(
      waitConfig({
        waitMode: "event",
        waitFor: [
          { event: "billing/payment.settled", match: '{"version":2}' },
          { event: "vendor/never.declared" },
        ],
        waitTimeout: "7d",
        waitTimeoutBehavior: "skip",
      })
    );

    expect(read.valid).toBe(true);
    if (read.valid) {
      expect(read.waitMode).toBe("event");
      expect(read.config.waitFor).toEqual([
        { event: "billing/payment.settled", match: '{"version":2}' },
        { event: "vendor/never.declared" },
      ]);
      expect(read.config.waitTimeoutBehavior).toBe("skip");
    }
  });

  // The retired third mode has no fallback path. A saved node holding it fails
  // this decode, which is where a graph written against the old shape stops.
  it("refuses the retired hook mode", () => {
    const read = readWaitConfig(
      waitConfig({ waitMode: "hook", waitHookToken: "token_abc" })
    );

    expect(read.valid).toBe(false);
  });

  it("refuses a subscription naming no Event", () => {
    expect(
      readWaitConfig(
        waitConfig({ waitMode: "event", waitFor: [{ event: "  " }] })
      ).valid
    ).toBe(false);
  });

  // An empty list would mean "any Event for this entity", which the
  // subscription index has no way to hold, so the shape refuses it outright.
  it("refuses an empty subscription list", () => {
    expect(
      readWaitConfig(waitConfig({ waitMode: "event", waitFor: [] })).valid
    ).toBe(false);
  });

  // The engine resolves templates into every declared config key, so a field a
  // builder left blank arrives present and holding undefined.
  it("accepts a key present and holding undefined", () => {
    expect(
      readWaitConfig(
        waitConfig({
          waitMode: "delay",
          waitDuration: "1h",
          waitUntil: undefined,
        })
      ).valid
    ).toBe(true);
  });

  // The bag carries an action's own keys beside the wait's, so the decode leaves
  // what it does not recognise where it found it.
  it("ignores the keys that are not the wait's", () => {
    expect(readWaitConfig(waitConfig({ integrationId: "int_1" })).valid).toBe(
      true
    );
  });
});

describe("readWaitSubscriptions", () => {
  it("answers with the subscriptions a config carries", () => {
    expect(
      readWaitSubscriptions(
        waitConfig({ waitFor: [{ event: "billing/payment.settled" }] })
      )
    ).toEqual([{ event: "billing/payment.settled" }]);
  });

  // The readers that render or index a graph want the Events a node names even
  // when the rest of its config is one a run would refuse.
  it("reads waitFor alone, whatever else the config holds", () => {
    expect(
      readWaitSubscriptions(
        waitConfig({
          waitMode: "hook",
          waitFor: [{ event: "billing/payment.settled" }],
        })
      )
    ).toEqual([{ event: "billing/payment.settled" }]);
  });

  it("answers with nothing for a config carrying no subscriptions", () => {
    expect(readWaitSubscriptions(waitConfig({}))).toEqual([]);
    expect(readWaitSubscriptions(undefined)).toEqual([]);
    expect(readWaitSubscriptions(waitConfig({ waitFor: "a,b" }))).toEqual([]);
  });
});

describe("DEFAULT_WAIT_TIMEOUT", () => {
  it("is the seven days the editor writes", () => {
    expect(DEFAULT_WAIT_TIMEOUT).toBe("7d");
  });
});

describe("waitValueTargetsFor", () => {
  it("reads the timeout only while the node parks on an Event", () => {
    expect(Object.keys(waitValueTargetsFor({ waitMode: "event" }))).toEqual([
      "waitTimeout",
    ]);
  });

  it("reads the duration on a clock, and neither target date nor timeout", () => {
    expect(
      Object.keys(
        waitValueTargetsFor({
          waitMode: "delay",
          waitDelayTimingMode: "duration",
        })
      )
    ).toEqual(["waitDuration"]);
  });

  it("reads the target date and its offset when the timing is a date", () => {
    expect(
      Object.keys(
        waitValueTargetsFor({ waitMode: "delay", waitDelayTimingMode: "until" })
      )
    ).toEqual(["waitUntil", "waitOffset"]);
  });

  it("takes a node carrying a target date as being on that timing", () => {
    // The timing key is written by the selector alone, so a graph that predates
    // it says which timing it is on by carrying a date.
    expect(
      Object.keys(waitValueTargetsFor({ waitUntil: "2026-03-10T09:00:00Z" }))
    ).toEqual(["waitUntil", "waitOffset"]);
  });

  it("names the keys the shape does not read, for the selector to clear", () => {
    // The case the rule exists for: a timeout left behind by a node switched
    // back to a clock is a value no run consults and no input shows.
    expect(waitValueKeysNotIn({ waitMode: "delay" })).toContain("waitTimeout");
    expect(waitValueKeysNotIn({ waitMode: "event" })).toEqual([
      "waitDuration",
      "waitUntil",
      "waitOffset",
    ]);
  });
});

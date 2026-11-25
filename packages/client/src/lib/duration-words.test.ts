import { describe, expect, it } from "vitest";
import { durationInWords, waitDurationReadback } from "#src/lib/duration-words";

describe("durationInWords", () => {
  it("names each unit a duration uses, largest first", () => {
    expect(durationInWords(86_400_000)).toBe("1 day");
    expect(durationInWords(9_000_000)).toBe("2 hours 30 minutes");
    expect(durationInWords(777_600_000)).toBe("1 week 2 days");
    expect(durationInWords(1500)).toBe("1 second 500 milliseconds");
  });
});

describe("waitDurationReadback", () => {
  it("reads every notation the wait accepts back in words", () => {
    expect(waitDurationReadback("1d")).toBe("Waits 1 day.");
    expect(waitDurationReadback("24h")).toBe("Waits 1 day.");
    expect(waitDurationReadback("P1D")).toBe("Waits 1 day.");
    expect(waitDurationReadback("90m")).toBe("Waits 1 hour 30 minutes.");
    expect(waitDurationReadback("3600000")).toBe("Waits 1 hour.");
  });

  // Typed text that runs two tokens together is read, and the readback is
  // what shows the builder it was not what they meant.
  it("shows what a run-together value adds up to", () => {
    expect(waitDurationReadback("10s1d")).toBe("Waits 1 day 10 seconds.");
  });

  it("says a zero duration does not wait", () => {
    expect(waitDurationReadback("0")).toBe("Does not wait.");
  });

  it("reads nothing back for blank, unreadable or templated text", () => {
    expect(waitDurationReadback("")).toBeNull();
    expect(waitDurationReadback("one day")).toBeNull();
    expect(waitDurationReadback("{{@n:Lifecycle.delay}}")).toBeNull();
  });
});

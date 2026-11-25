import { describe, expect, it } from "vitest";
import { testRunSkip } from "./test-run-skip";

describe("testRunSkip", () => {
  it("names the Test Mode Behavior that made an integration step do nothing", () => {
    expect(
      testRunSkip({
        runMode: "test",
        status: "success",
        output: { ts: "", channel: "#ops", reasonCode: "test_mode_log_only" },
      })
    ).toBe(
      "Test Mode Behavior is Log only, so this test run did nothing at this step."
    );
    expect(
      testRunSkip({
        runMode: "test",
        status: "success",
        output: { reasonCode: "test_mode_log_fallback_missing_test_phone" },
      })
    ).toBe(
      "Test Phone Number is empty, so this test run did nothing at this step."
    );
  });

  it("reads a reason code it does not know as a skip all the same", () => {
    expect(
      testRunSkip({
        runMode: "test",
        status: "success",
        output: { reasonCode: "test_mode_something_new" },
      })
    ).toBe("This test run did nothing at this step.");
  });

  it("reads a host action's skipped status in a test run", () => {
    expect(
      testRunSkip({
        runMode: "test",
        status: "success",
        output: { status: "skipped" },
      })
    ).toBe("The app skips this step in a test run.");
  });

  it("claims nothing for a live run, a failed step, or a step that did its work", () => {
    const skipped = { status: "skipped", reasonCode: "test_mode_log_only" };
    expect(
      testRunSkip({ runMode: "live", status: "success", output: skipped })
    ).toBeNull();
    expect(
      testRunSkip({ runMode: "test", status: "error", output: skipped })
    ).toBeNull();
    expect(
      testRunSkip({
        runMode: "test",
        status: "success",
        output: { status: "sent" },
      })
    ).toBeNull();
    expect(
      testRunSkip({ runMode: "test", status: "success", output: ["skipped"] })
    ).toBeNull();
  });
});

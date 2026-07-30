import { describe, expect, it } from "vitest";
import { readWaitForEvents, waitMatchesEvent } from "./wait-events";

describe("readWaitForEvents", () => {
  it("reads a list the editor wrote", () => {
    expect(
      readWaitForEvents(["appointment.confirmed", "appointment.cancelled"])
    ).toEqual(["appointment.confirmed", "appointment.cancelled"]);
  });

  // Anything that is not a list is not a list of Event Types, so it names no
  // event and the wait resumes on any of them.
  it("reports no list for a value that is not an array", () => {
    expect(readWaitForEvents(undefined)).toEqual([]);
    expect(readWaitForEvents(null)).toEqual([]);
    expect(readWaitForEvents("appointment.confirmed")).toEqual([]);
    expect(readWaitForEvents("a,b")).toEqual([]);
    expect(readWaitForEvents({ 0: "appointment.confirmed" })).toEqual([]);
  });

  // Blank strings are what an editing session leaves behind, and a number was
  // never a matchable Event Type; both drop out rather than blocking a resume.
  it("keeps only the non-blank strings in a mixed array", () => {
    expect(
      readWaitForEvents([
        "appointment.confirmed",
        "",
        "   ",
        42,
        null,
        { eventType: "appointment.cancelled" },
        "appointment.cancelled",
      ])
    ).toEqual(["appointment.confirmed", "appointment.cancelled"]);
  });

  it("reports no list for an array with nothing matchable in it", () => {
    expect(readWaitForEvents(["", "  ", 7])).toEqual([]);
  });
});

describe("waitMatchesEvent", () => {
  // The wildcard is gone: an empty list has no meaning the derived subscription
  // index can hold, so it is refused at save instead.
  it("matches nothing when the list is empty", () => {
    expect(waitMatchesEvent([], "appointment.created")).toBe(false);
  });

  it("matches an event the list names", () => {
    expect(
      waitMatchesEvent(
        ["appointment.confirmed", "appointment.cancelled"],
        "appointment.cancelled"
      )
    ).toBe(true);
  });

  it("does not match an event the list leaves out", () => {
    expect(
      waitMatchesEvent(
        ["appointment.confirmed", "appointment.cancelled"],
        "appointment.rescheduled"
      )
    ).toBe(false);
  });
});

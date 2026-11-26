import { afterEach, describe, expect, it } from "vitest";
import { closestScroller, scrollIntoScroller } from "./scroll-into-scroller";

function boxed(top: number, height: number): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () =>
    DOMRect.fromRect({ x: 0, y: top, width: 300, height });
  return element;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("scrollIntoScroller", () => {
  it("scrolls down only until the element's bottom edge shows", () => {
    const scroller = boxed(100, 400);
    scroller.scrollTop = 50;
    scrollIntoScroller(scroller, boxed(480, 40));
    expect(scroller.scrollTop).toBe(70);
  });

  it("scrolls up only until the element's top edge shows", () => {
    const scroller = boxed(100, 400);
    scroller.scrollTop = 200;
    scrollIntoScroller(scroller, boxed(60, 40));
    expect(scroller.scrollTop).toBe(160);
  });

  it("leaves an element already in view where it is", () => {
    const scroller = boxed(100, 400);
    scroller.scrollTop = 200;
    scrollIntoScroller(scroller, boxed(150, 40));
    expect(scroller.scrollTop).toBe(200);
  });

  it("lines up the top of an element taller than the scroller", () => {
    const scroller = boxed(100, 400);
    scroller.scrollTop = 0;
    scrollIntoScroller(scroller, boxed(300, 600));
    expect(scroller.scrollTop).toBe(200);
  });
});

describe("closestScroller", () => {
  it("finds the nearest ancestor that scrolls vertically, up to the boundary", () => {
    const boundary = document.createElement("section");
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const field = document.createElement("input");
    scroller.append(field);
    boundary.append(scroller);
    document.body.append(boundary);
    expect(closestScroller(field, boundary)).toBe(scroller);
  });

  it("answers null when nothing up to the boundary scrolls", () => {
    const outer = document.createElement("div");
    outer.style.overflowY = "auto";
    const boundary = document.createElement("section");
    const field = document.createElement("input");
    boundary.append(field);
    outer.append(boundary);
    document.body.append(outer);
    expect(closestScroller(field, boundary)).toBeNull();
  });
});

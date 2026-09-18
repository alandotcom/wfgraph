/** The window happy-dom provides, whose viewport a test can resize. */
type HappyDomWindow = {
  happyDOM: { setViewport: (viewport: { width: number }) => void };
};

function isHappyDomWindow(value: object): value is HappyDomWindow {
  return "happyDOM" in value;
}

/**
 * Set happy-dom's viewport width, which the `md` media query answers from.
 * Throws outside happy-dom.
 */
export function setViewportWidth(width: number): void {
  if (!isHappyDomWindow(window)) {
    throw new Error("setViewportWidth runs only under happy-dom");
  }
  window.happyDOM.setViewport({ width });
}

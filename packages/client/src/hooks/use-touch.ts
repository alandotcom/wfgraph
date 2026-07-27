/**
 * Whether the device can be touched.
 *
 * A plain function rather than a hook, because this never changes for the life
 * of a page: the answer is a property of the hardware, not of the render. Used
 * to decide whether autofocusing a text input is welcome or whether it would
 * throw an on-screen keyboard over the content the user is looking at.
 */
export function hasTouchSupport() {
  return (
    "ontouchstart" in window ||
    navigator.maxTouchPoints > 0 ||
    // @ts-expect-error - msMaxTouchPoints is IE-specific
    navigator.msMaxTouchPoints > 0
  );
}

import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OverlayContainer } from "#src/components/overlays/overlay-container";
import {
  OverlayProvider,
  useOverlay,
} from "#src/components/overlays/overlay-provider";

/**
 * An overlay body with the title element the container focuses first. The
 * test DOM has no layout, so the container's search for a visible text field
 * finds none and falls through to this title, as it does for a confirmation.
 */
function Panel() {
  return (
    <h2 id="overlay-title-test" tabIndex={-1}>
      Choose a patient
    </h2>
  );
}

function Opener() {
  const { open } = useOverlay();
  return (
    <button onClick={() => open(Panel, {})} type="button">
      Run draft
    </button>
  );
}

/** Let the container's after-paint focus pass and its timers run. */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("OverlayContainer focus", () => {
  it("gives focus back to the opener when the last overlay closes", async () => {
    render(
      <OverlayProvider>
        <Opener />
        <OverlayContainer />
      </OverlayProvider>
    );

    const opener = screen.getByRole("button", { name: "Run draft" });
    opener.focus();
    fireEvent.click(opener);
    await settle();
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Choose a patient" })
    );

    fireEvent.keyDown(document, { key: "Escape" });
    await settle();

    // The dialog can still be mounted here while its exit plays. Focus stays
    // on the opener through that exit.
    expect(document.activeElement).toBe(opener);
  });
});

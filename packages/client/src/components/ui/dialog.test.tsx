import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "#src/components/ui/dialog";

describe("Dialog motion", () => {
  it("lets a surface opt out of entrance motion", () => {
    render(
      <Dialog open>
        <DialogContent motion={false}>
          <DialogTitle>Commands</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const content = document.querySelector('[data-slot="dialog-content"]');
    const overlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(content?.className).not.toContain("animate-in");
    expect(overlay?.className).not.toContain("animate-in");
  });

  it("uses modal timing and a non-spatial reduced-motion fallback by default", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const content = document.querySelector('[data-slot="dialog-content"]');

    expect(content?.className).toContain("duration-200");
    expect(content?.className).toContain("motion-reduce:animate-none");
    expect(content?.className).toContain("motion-reduce:transition-opacity");
  });

  it("dims the page with the shared scrim and no blur", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Settings</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(overlay?.className).toContain("bg-scrim");
    expect(overlay?.className).not.toContain("backdrop-blur");
  });

  it("lets a surface that acts on the page drop the scrim", () => {
    render(
      <Dialog open>
        <DialogContent overlayClassName="bg-transparent">
          <DialogTitle>Commands</DialogTitle>
        </DialogContent>
      </Dialog>
    );

    const overlay = document.querySelector('[data-slot="dialog-overlay"]');

    expect(overlay?.className).toContain("bg-transparent");
    expect(overlay?.className).not.toContain("bg-scrim");
  });
});

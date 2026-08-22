import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { DeleteConfirmDialog } from "#src/components/delete-confirm-dialog";

function ControlledDialog({ onConfirm }: { onConfirm: () => void }) {
  const [open, setOpen] = useState(true);

  return (
    <DeleteConfirmDialog
      onConfirm={onConfirm}
      onOpenChange={setOpen}
      open={open}
    />
  );
}

describe("DeleteConfirmDialog", () => {
  it("closes after confirming", async () => {
    const onConfirm = vi.fn();
    render(<ControlledDialog onConfirm={onConfirm} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    expect(onConfirm).toHaveBeenCalledOnce();
    await waitFor(() => {
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });
  });
});

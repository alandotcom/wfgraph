/**
 * The confirmation for deleting a Group frame together with every step inside
 * it. The canvas context menu and the node inspector both ask with this one
 * request, so the wording and the destructive button style cannot drift apart.
 */

import type { ConfirmRequest } from "./node-config-panel";

export function deleteGroupWithStepsConfirmation(
  onConfirm: () => void
): ConfirmRequest & { confirmVariant: "destructive" } {
  return {
    title: "Delete Group and Steps",
    message:
      "Are you sure you want to delete this Group and every step inside it? The steps' connections are deleted too.",
    confirmLabel: "Delete Group and Steps",
    confirmVariant: "destructive",
    onConfirm,
  };
}

import { describe, expect, it } from "vitest";
import { groupEventChoices } from "#src/components/workflow/config/event-combobox";

describe("groupEventChoices", () => {
  // A host Event is what a workflow in this app usually starts on, and an
  // integration can declare nineteen of its own ahead of it in the catalog.
  it("lists the host app's own Events ahead of every integration's", () => {
    const groups = groupEventChoices([
      { name: "resend/email.sent", label: "Email sent", group: "Resend" },
      { name: "linear/issue.created", label: "Issue created", group: "Linear" },
      { name: "app/payment.settled", label: "Payment settled" },
      { name: "resend/email.bounced", label: "Email bounced", group: "Resend" },
      { name: "app/appointment.created", label: "Appointment created" },
    ]);

    expect(
      groups.map((group) => [group.value, group.items.map((item) => item.name)])
    ).toEqual([
      ["This app", ["app/payment.settled", "app/appointment.created"]],
      ["Resend", ["resend/email.sent", "resend/email.bounced"]],
      ["Linear", ["linear/issue.created"]],
    ]);
  });
});

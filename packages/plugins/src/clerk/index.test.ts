import { requireOutputFieldsFromSchema } from "@wfgraph/core/plugin";
import { describe, expect, it } from "vitest";
import { clerk } from "#src/clerk/index";

function outputFieldsOf(slug: keyof typeof clerk.actions) {
  return requireOutputFieldsFromSchema(
    `Action "clerk/${slug}"`,
    clerk.actions[slug].output
  );
}

/**
 * What a node downstream of a Clerk node can reference.
 *
 * The four paths the hand-written lists carried keep their exact descriptions,
 * and `createdAt` and `updatedAt` -- which the three user-returning steps have
 * always answered with and never offered -- are here too.
 */
const USER_FIELDS = [
  { path: "id", description: "User ID", type: "string" },
  {
    path: "firstName",
    description: "First name",
    type: "string",
    nullable: true,
  },
  {
    path: "lastName",
    description: "Last name",
    type: "string",
    nullable: true,
  },
  {
    path: "primaryEmailAddress",
    description: "Primary email address",
    type: "string",
    nullable: true,
  },
  {
    path: "createdAt",
    description: "When the user was created, epoch milliseconds",
    type: "number",
  },
  {
    path: "updatedAt",
    description: "When the user was last updated, epoch milliseconds",
    type: "number",
  },
];

describe("the clerk integration", () => {
  it("declares its credentials and its actions as one value", () => {
    expect(clerk.type).toBe("clerk");
    expect(clerk.test).toBeDefined();
    expect(Object.keys(clerk.credentials)).toEqual(["CLERK_SECRET_KEY"]);
    expect(Object.keys(clerk.actions)).toEqual([
      "get-user",
      "create-user",
      "update-user",
      "delete-user",
    ]);
  });

  it.each(["get-user", "create-user", "update-user"] as const)(
    "offers the whole user for %s",
    (slug) => {
      expect(outputFieldsOf(slug)).toEqual(USER_FIELDS);
    }
  );

  it("offers the deletion flag for delete-user", () => {
    expect(outputFieldsOf("delete-user")).toEqual([
      { path: "deleted", description: "Deletion success", type: "boolean" },
    ]);
  });
});

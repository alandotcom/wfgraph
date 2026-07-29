import { findActionById } from "@rova/shared/plugins/registry";
import { describe, expect, it } from "vitest";
import "#src/clerk/index";

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

describe("clerk output fields", () => {
  it.each(["get-user", "create-user", "update-user"])(
    "offers the whole user for %s",
    (slug) => {
      const action = findActionById(`clerk/${slug}`);

      expect(action?.outputFields).toEqual(USER_FIELDS);
    }
  );

  it("offers the deletion flag for delete-user", () => {
    const action = findActionById("clerk/delete-user");

    expect(action?.outputFields).toEqual([
      { path: "deleted", description: "Deletion success", type: "boolean" },
    ]);
  });
});

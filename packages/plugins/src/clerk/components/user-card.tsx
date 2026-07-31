import { compact } from "es-toolkit/array";
import { Schema } from "effect";
import type { ResultComponentProps } from "#src/ui";
import { readAs } from "@rova/shared/types/schema";

// This component renders a Clerk step's result read back out of the execution log,
// so the output arrives as untyped JSON. The logging layer unwraps the standardized
// { success, data } wrapper, leaving the user data a Clerk step returned. Anything
// that is not that user shape renders nothing.
const readClerkUserData = readAs(
  Schema.Struct({
    id: Schema.String,
    firstName: Schema.NullOr(Schema.String),
    lastName: Schema.NullOr(Schema.String),
    primaryEmailAddress: Schema.NullOr(Schema.String),
    createdAt: Schema.Finite,
  })
);

export function UserCard({ output }: ResultComponentProps) {
  const data = readClerkUserData(output);
  if (!data) {
    return null;
  }

  const initials = compact([data.firstName?.[0], data.lastName?.[0]])
    .join("")
    .toUpperCase();

  const fullName = compact([data.firstName, data.lastName]).join(" ");
  const createdDate = new Date(data.createdAt).toLocaleDateString();

  return (
    <div className="flex items-center gap-4">
      <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-violet-600 font-semibold text-lg text-white">
        {initials || "?"}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">
          {fullName || "Unknown User"}
        </div>
        {data.primaryEmailAddress && (
          <div className="truncate text-muted-foreground text-sm">
            {data.primaryEmailAddress}
          </div>
        )}
        <div className="mt-0.5 font-mono text-muted-foreground text-xs">
          Created {createdDate}
        </div>
      </div>
    </div>
  );
}

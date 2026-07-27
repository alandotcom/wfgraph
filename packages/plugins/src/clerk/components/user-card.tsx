import { compact } from "es-toolkit/array";
import { z } from "zod";
import type { ResultComponentProps } from "@rova/shared/plugins/ui-registry";

// This component renders a Clerk step's result read back out of the execution log,
// so the output arrives as untyped JSON. The logging layer unwraps the standardized
// { success, data } wrapper, leaving the user data a Clerk step returned. Anything
// that is not that user shape renders nothing.
const clerkUserDataSchema = z.object({
  id: z.string(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  primaryEmailAddress: z.string().nullable(),
  createdAt: z.number(),
});

export function UserCard({ output }: ResultComponentProps) {
  const parsed = clerkUserDataSchema.safeParse(output);
  if (!parsed.success) {
    return null;
  }

  const data = parsed.data;

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

import { compact } from "es-toolkit/array";
import type { ResultComponentProps } from "@/plugins/registry";

// The logging layer unwraps standardized outputs, so we receive just the data
type ClerkUserData = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  primaryEmailAddress: string | null;
  createdAt: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function toNumberOrZero(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function parseClerkUserData(output: unknown): ClerkUserData | null {
  if (!isRecord(output) || typeof output.id !== "string") {
    return null;
  }

  return {
    id: output.id,
    firstName: toNullableString(output.firstName),
    lastName: toNullableString(output.lastName),
    primaryEmailAddress: toNullableString(output.primaryEmailAddress),
    createdAt: toNumberOrZero(output.createdAt),
  };
}

export function UserCard({ output }: ResultComponentProps) {
  const data = parseClerkUserData(output);
  if (!data) {
    return null;
  }

  const initials = compact([data.firstName?.[0], data.lastName?.[0]])
    .join("")
    .toUpperCase();

  const fullName = compact([data.firstName, data.lastName]).join(" ");
  const createdDate = data.createdAt
    ? new Date(data.createdAt).toLocaleDateString()
    : "Unknown";

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

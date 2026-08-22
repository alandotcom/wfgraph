import * as stylex from "@stylexjs/stylex";
import { Icon } from "@astryxdesign/core/Icon";
import { colorVars, spacingVars } from "@astryxdesign/core/theme/tokens.stylex";
import { AlertTriangle } from "lucide-react";
import type { NodeIssueSummary } from "#src/lib/workflow-graph-types";

export function nodeIssueLabel(issues: NodeIssueSummary | undefined): string {
  if (!issues) return "";
  const count = issues.messages.length;
  const noun = count === 1 ? "issue" : "issues";
  return issues.severity === "blocking" ? `${count} blocking ${noun}` : `${count} ${noun}`;
}

export function NodeIssueBadge({ issues, placement = "corner" }: { issues: NodeIssueSummary | undefined; placement?: "corner" | "inline" }) {
  if (!issues) return null;
  const [first, ...rest] = issues.messages;
  return (
    <span
      aria-label={nodeIssueLabel(issues)}
      {...stylex.props(styles.badge, placement === "corner" ? styles.corner : styles.inline, issues.severity === "blocking" ? styles.blocking : styles.warning)}
      role="img"
      title={rest.length > 0 ? `${first} and ${rest.length} more` : first}
    >
      <Icon icon={AlertTriangle} size="sm" />
    </span>
  );
}

const styles = stylex.create({
  badge: { alignItems: "center", borderRadius: 999, display: "inline-flex", justifyContent: "center", padding: spacingVars["--spacing-1"] },
  corner: { left: spacingVars["--spacing-2"], position: "absolute", top: spacingVars["--spacing-2"], zIndex: 10 },
  inline: { flexShrink: 0 },
  blocking: { backgroundColor: colorVars["--color-text-yellow"], color: colorVars["--color-background-card"] },
  warning: { backgroundColor: colorVars["--color-text-secondary"], color: colorVars["--color-background-card"] },
});

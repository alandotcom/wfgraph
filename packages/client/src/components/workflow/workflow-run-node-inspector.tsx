import { ArrowLeft } from "lucide-react";
import { useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { Button } from "#src/components/ui/button";
import { ConfigSection } from "#src/components/workflow/config/config-section";
import {
  displayNodesAtom,
  selectedNodeAtom,
} from "#src/lib/workflow-graph-store";
import type { ExecutionLog } from "#src/lib/execution-logs";
import {
  CopyButton,
  formatDuration,
  getStatusTextClass,
  JSON_PRE_CLASS,
  JsonWithLinks,
  nodeKindLabel,
  OutputDisplay,
} from "./workflow-run-shared";

const ignoreEditingChange = (_editing: boolean) => undefined;

function ViewSection({
  label,
  trailing,
  children,
}: {
  label: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <ConfigSection
      editable={false}
      editing={false}
      label={label}
      onEditingChange={ignoreEditingChange}
      trailing={trailing}
      view={children}
    >
      {null}
    </ConfigSection>
  );
}

function hasRecordedValue(value: unknown): boolean {
  return value !== null && value !== undefined;
}

export function WorkflowRunNodeInspector({ logs }: { logs: ExecutionLog[] }) {
  const selectedNodeId = useAtomValue(selectedNodeAtom);
  const displayNodes = useAtomValue(displayNodesAtom);
  const setSelectedNode = useSetAtom(selectedNodeAtom);

  if (!selectedNodeId) {
    return null;
  }

  const canvasNode = displayNodes.find((node) => node.id === selectedNodeId);
  const log = logs.find((entry) => entry.nodeId === selectedNodeId);
  const title =
    canvasNode?.data.label?.trim() || log?.nodeName || log?.nodeType || "Node";
  const kind = nodeKindLabel(
    log?.nodeType ?? canvasNode?.data.type ?? "action"
  );
  const statusLabel = log ? (
    <span className={getStatusTextClass(log.status)}>
      {log.status === "success"
        ? "Success"
        : log.status === "error"
          ? "Error"
          : log.status === "running"
            ? "Running"
            : log.status === "cancelled"
              ? "Cancelled"
              : "Pending"}
    </span>
  ) : (
    <span className="text-muted-foreground">Did not run</span>
  );

  return (
    <div className="space-y-4">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-1">
          <Button
            aria-label="Back to run overview"
            onClick={() => setSelectedNode(null)}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
          <h2 className="min-w-0 font-semibold text-base">{title}</h2>
        </div>
        <p className="flex flex-wrap items-baseline gap-x-1.5 text-muted-foreground text-xs">
          <span>{kind}</span>
          <span>·</span>
          {statusLabel}
          {log?.duration ? (
            <>
              <span>·</span>
              <span className="font-mono tabular-nums">
                {formatDuration(log.duration)}
              </span>
            </>
          ) : null}
        </p>
      </div>

      {log ? (
        hasRecordedValue(log.input) ||
        hasRecordedValue(log.output) ||
        log.error ? (
          <div className="space-y-4">
            {hasRecordedValue(log.input) ? (
              <ViewSection
                label="Input"
                trailing={<CopyButton data={log.input} />}
              >
                <pre className={JSON_PRE_CLASS}>
                  <JsonWithLinks data={log.input} />
                </pre>
              </ViewSection>
            ) : null}
            {hasRecordedValue(log.output) ? (
              <ViewSection
                label="Output"
                trailing={<CopyButton data={log.output} />}
              >
                <OutputDisplay
                  actionType={log.nodeType}
                  compact
                  input={log.input}
                  output={log.output}
                />
              </ViewSection>
            ) : null}
            {log.error ? (
              <ViewSection
                label="Error"
                trailing={<CopyButton data={log.error} isError />}
              >
                <pre className={`${JSON_PRE_CLASS} text-destructive`}>
                  {log.error}
                </pre>
              </ViewSection>
            ) : null}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">No data recorded.</p>
        )
      ) : (
        <p className="text-muted-foreground text-xs">This node did not run.</p>
      )}
    </div>
  );
}

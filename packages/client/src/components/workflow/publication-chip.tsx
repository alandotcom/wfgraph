/**
 * The open workflow's publication state, stated once beside its name.
 *
 * The chip reads the state in the Workflows list's words, followed by the
 * published version and whether the draft holds changes it does not: "Live ·
 * v2 · changes not published", "Test · v3", "Never published", "Paused". Its
 * menu holds what changes that state or looks into it: Published mode, Pause
 * or Resume, Version history and Review changes. Nothing renders until the
 * workflow's payload arrives, because "Live" is a claim about whether real
 * messages go out and a guess at it is worse than a blank.
 */

import { useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import { ChevronDown, Circle, Pause, Play } from "lucide-react";
import { Button } from "#src/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#src/components/ui/dropdown-menu";
import { useSetPublishedMode } from "#src/hooks/use-set-published-mode";
import { useSetWorkflowPaused } from "#src/hooks/use-set-workflow-paused";
import { can } from "#src/lib/authorization";
import {
  WorkflowCommandIcon,
  type WorkflowCommand,
} from "#src/lib/workflow-commands";
import { workflowPublicationQueryOptions } from "#src/lib/rpc-query";
import {
  publicationChipLabel,
  publishedModeChoice,
  workflowPublicationState,
} from "#src/lib/workflow-run-labels";
import { currentWorkflowModeAtom } from "#src/lib/workflow-save-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import { cn } from "@wfgraph/shared/utils";

/** The two modes, live first, because that is the mode a workflow ends up in. */
const PUBLISHED_MODES = ["live", "test"] as const;

export function PublicationChip({
  workflowId,
  commands,
}: {
  workflowId: string | undefined;
  /** Version history and Review changes, gated as the palette gates them. */
  commands: readonly WorkflowCommand[];
}) {
  const workflowMode = useAtomValue(currentWorkflowModeAtom);
  const setPublishedMode = useSetPublishedMode();
  const pause = useSetWorkflowPaused(workflowId);
  const { data: publication } = useQuery({
    ...workflowPublicationQueryOptions(workflowId ?? ""),
    enabled: Boolean(workflowId),
  });
  if (!publication) {
    return null;
  }

  const state = workflowPublicationState({
    isPaused: publication.isPaused,
    isPublished: publication.isPublished,
    workflowMode,
  });
  const label = publicationChipLabel({
    isPaused: publication.isPaused,
    isPublished: publication.isPublished,
    workflowMode,
    publishedVersion: publication.publishedVersion,
    hasUnpublishedChanges: publication.hasUnpublishedChanges,
  });
  const canSetMode = can(WfGraphOperations.workflowUpdate.id);
  // A workflow with no published version starts no run, so there is nothing
  // for a pause to stop. A paused one can always resume.
  const canTogglePause =
    can(WfGraphOperations.workflowBulkLifecycle.id) &&
    (publication.isPaused || publication.isPublished);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            // The accessible name leads with the visible words, and says what
            // they describe.
            aria-label={`Publication: ${label}`}
            className="min-w-0 max-w-64 shrink font-normal text-muted-foreground"
            size="default"
            variant="ghost"
          />
        }
        title={label}
      >
        {/* The dot is the list's: filled green for Live, filled amber for
            Test, an outline where the workflow reaches no one. */}
        <Circle
          aria-hidden
          className={cn(
            "size-2.5 shrink-0",
            state === "live" && "fill-current text-success",
            state === "test" && "fill-current text-warning"
          )}
          data-icon="inline-start"
        />
        <span className="truncate">{label}</span>
        <ChevronDown className="size-3 opacity-50" data-icon="inline-end" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            Published mode
            {/* Before the first publish the setting describes a version
                nobody can run yet, so the title says when it starts to
                matter. */}
            {publication.isPublished ? null : (
              <span className="block font-normal text-muted-foreground text-xs">
                Takes effect on publish
              </span>
            )}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            onValueChange={(mode) => {
              if (mode === "live" || mode === "test") {
                void setPublishedMode(mode);
              }
            }}
            value={workflowMode}
          >
            {PUBLISHED_MODES.map((mode) => {
              const choice = publishedModeChoice(mode);
              return (
                <DropdownMenuRadioItem
                  // The check sits at the start of the row so the current
                  // mode is read before the word.
                  className="pr-2 pl-8 [&>[data-slot=dropdown-menu-radio-item-indicator]]:right-auto [&>[data-slot=dropdown-menu-radio-item-indicator]]:left-2"
                  disabled={!canSetMode}
                  key={mode}
                  value={mode}
                >
                  <span>
                    {choice.label}
                    <span className="block font-normal text-muted-foreground text-xs">
                      {choice.description}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {canTogglePause ? (
          <DropdownMenuItem
            disabled={pause.isPending}
            onClick={() => pause.setPaused(!publication.isPaused)}
          >
            {publication.isPaused ? <Play /> : <Pause />}
            {publication.isPaused ? "Resume workflow" : "Pause workflow"}
          </DropdownMenuItem>
        ) : null}
        {commands.map((command) => (
          <DropdownMenuItem
            disabled={command.disabled}
            key={command.id}
            onClick={command.execute}
          >
            <WorkflowCommandIcon id={command.id} />
            {command.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

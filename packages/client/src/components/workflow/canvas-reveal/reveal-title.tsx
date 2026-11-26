import { useSetAtom } from "jotai";
import { type KeyboardEvent, type Ref, useRef } from "react";
import { Input } from "#src/components/ui/input";
import { useCanvasInteraction } from "#src/components/workflow/canvas-interaction";
import { updateNodeDataAtom } from "#src/lib/workflow-graph-store";
import { cn } from "@wfgraph/shared/utils";

/** The element id of the name field in the Inspector's or a sheet's title. */
export const REVEAL_NAME_FIELD_ID = "reveal-name";

/**
 * The stored label a Draft step, Group or Lifecycle Node shows as its name,
 * and the name its kind shows while that label is empty.
 */
export type RevealName = {
  nodeId: string;
  label: string;
  fallback: string;
};

/**
 * The title of the Inspector or of a phone sheet. For a Draft object the
 * person may edit, it holds the object's name as a field that looks like the
 * title at rest: each keystroke writes the label to the graph store, Enter
 * keeps what was typed, and Escape puts back the label the field had when it
 * took focus. Both hand focus to the heading, so the next Escape is the
 * Inspector's. An empty label shows the kind's own name, as the card does.
 * Without a name, or while the Draft takes no edits, the title is plain text.
 * The heading carries `tabIndex={-1}` so a sheet or the Inspector can focus
 * it without starting an edit.
 */
export function RevealTitle({
  title,
  name,
  titleRef,
  size,
}: {
  title: string;
  name: RevealName | null;
  titleRef: Ref<HTMLHeadingElement>;
  /** A phone sheet's field is a 44px target with 1rem text. */
  size: "inspector" | "sheet";
}) {
  const { editsDraft } = useCanvasInteraction();
  const updateNodeData = useSetAtom(updateNodeDataAtom);
  // The node and label the field held when it took focus, which Escape
  // restores.
  const atFocus = useRef<{ nodeId: string; label: string } | null>(null);
  const editable = name !== null && editsDraft;

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (name === null || (event.key !== "Enter" && event.key !== "Escape")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const start = atFocus.current;
    if (
      event.key === "Escape" &&
      start !== null &&
      start.nodeId === name.nodeId &&
      start.label !== name.label
    ) {
      updateNodeData({ id: name.nodeId, data: { label: start.label } });
    }
    event.currentTarget
      .closest<HTMLElement>('[data-slot="reveal-title"]')
      ?.focus({ preventScroll: true });
  };

  return (
    <h2
      // A heading holding a field takes its name from the field's value, which
      // is empty while the kind's default name shows, so it states the title.
      aria-label={editable ? title : undefined}
      className={cn(
        "min-w-0 outline-none",
        size === "inspector" && "flex-1",
        // The plain title of the Inspector pads itself; a sheet's title sits
        // in a padded column with its status under it.
        !editable && "truncate font-semibold text-sm",
        !editable && size === "inspector" && "px-1"
      )}
      data-slot="reveal-title"
      ref={titleRef}
      tabIndex={-1}
    >
      {editable ? (
        <Input
          aria-label="Name"
          autoComplete="off"
          className={cn(
            // One px of transparent border plus three of padding puts the
            // name where a read-only title's four px of padding put it.
            "w-full truncate rounded-md border-transparent bg-transparent px-[3px] py-0 font-semibold shadow-none transition-colors dark:bg-transparent",
            "placeholder:text-foreground hover:bg-muted/60 focus-visible:bg-background focus-visible:placeholder:text-muted-foreground",
            size === "sheet"
              ? "h-11 text-base md:text-base"
              : "h-7 text-sm md:text-sm"
          )}
          // The field answers its own Escape, so the Inspector's Escape
          // handler leaves it alone.
          data-owns-escape="true"
          id={REVEAL_NAME_FIELD_ID}
          // Keyed to the node, so a field left focused on one object never
          // writes its Escape into the next one's label.
          key={name.nodeId}
          onBlur={() => {
            atFocus.current = null;
          }}
          onChange={(event) =>
            updateNodeData({
              id: name.nodeId,
              data: { label: event.target.value },
            })
          }
          onFocus={() => {
            atFocus.current = { nodeId: name.nodeId, label: name.label };
          }}
          onKeyDown={onKeyDown}
          placeholder={name.fallback}
          spellCheck={false}
          value={name.label}
        />
      ) : (
        title
      )}
    </h2>
  );
}

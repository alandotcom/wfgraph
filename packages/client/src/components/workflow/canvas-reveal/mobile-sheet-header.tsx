import { ChevronLeft, Maximize2, X } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "#src/components/ui/button";
import { statusToneTextClass } from "#src/components/workflow/workflow-run-shared";
import { cn } from "@wfgraph/shared/utils";
import type { RevealHeaderModel } from "./reveal-header";

/**
 * What the mobile Reveal shell hands a sheet header. `back` runs Back, which
 * the shell answers through the kind's mobile unwind. `openInspector` opens the
 * inspector over the sheet, and is null when the sheet offers none. `titleRef`
 * goes on the sheet title, which takes focus as a sheet opens.
 */
export type MobileSheetControls = {
  back: () => void;
  openInspector: (() => void) | null;
  titleRef: RefObject<HTMLHeadingElement | null>;
};

/**
 * The header of a mobile Reveal sheet. `backLabel` names where Back leads, and
 * a null `backLabel` belongs to a first sheet, which offers Close. The sheet's
 * title and status follow, and then the control named `inspectorLabel` when
 * the sheet offers an inspector.
 */
export function MobileSheetHeader({
  title,
  status,
  backLabel,
  inspectorLabel,
  controls,
}: {
  title: string;
  status: RevealHeaderModel["status"];
  backLabel: string | null;
  inspectorLabel: string;
  controls: MobileSheetControls;
}) {
  const { back, openInspector, titleRef } = controls;
  return (
    <header className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
      {backLabel === null ? null : (
        <Button
          aria-label={`Back to ${backLabel}`}
          className="h-11 max-w-[40%] shrink-0 px-2"
          onClick={back}
          type="button"
          variant="ghost"
        >
          <ChevronLeft className="size-4" />
          <span className="truncate">{backLabel}</span>
        </Button>
      )}
      <div className="min-w-0 flex-1 px-2">
        <h2
          className="truncate font-semibold text-sm outline-none"
          data-slot="reveal-title"
          ref={titleRef}
          tabIndex={-1}
        >
          {title}
        </h2>
        {status ? (
          <p
            className={cn("truncate text-xs", statusToneTextClass(status.tone))}
          >
            {status.text}
          </p>
        ) : null}
      </div>
      {openInspector === null ? null : (
        <Button
          className="h-11 shrink-0 px-3"
          onClick={openInspector}
          type="button"
          variant="outline"
        >
          <Maximize2 className="size-4" />
          {inspectorLabel}
        </Button>
      )}
      {backLabel === null ? (
        <Button
          aria-label="Close"
          className="size-11 shrink-0"
          onClick={back}
          size="icon"
          type="button"
          variant="ghost"
        >
          <X className="size-4" />
        </Button>
      ) : null}
    </header>
  );
}

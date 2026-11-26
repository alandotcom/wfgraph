import { ChevronLeft, Maximize2, X } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "#src/components/ui/button";
import { statusToneTextClass } from "#src/components/workflow/workflow-run-shared";
import { cn } from "@wfgraph/shared/utils";
import type { RevealHeaderModel } from "./reveal-header";
import { RevealTitle } from "./reveal-title";

/**
 * What the mobile Reveal shell hands a sheet header. `back` runs Back, which
 * the shell answers through the kind's mobile unwind. `openFullSheet` opens the
 * full sheet over the sheet, and is null when the sheet offers none. `titleRef`
 * goes on the sheet title, which takes focus as a sheet opens.
 */
export type MobileSheetControls = {
  back: () => void;
  openFullSheet: (() => void) | null;
  titleRef: RefObject<HTMLHeadingElement | null>;
};

/**
 * The header of a mobile Reveal sheet. Back is named for the kind's
 * `backLabel`; without one, the sheet offers Close. The sheet's title, which
 * renames a Draft object in place as the Inspector's does, and status follow,
 * and then the control named `fullSheetLabel` that opens the full sheet, shown when the sheet
 * offers one and the kind names the control.
 */
export function MobileSheetHeader({
  title,
  name,
  status,
  backLabel,
  fullSheetLabel,
  controls,
}: {
  title: string;
  name: RevealHeaderModel["name"];
  status: RevealHeaderModel["status"];
  backLabel: string | null;
  fullSheetLabel?: string | undefined;
  controls: MobileSheetControls;
}) {
  const { back, openFullSheet, titleRef } = controls;
  const shownBackLabel = backLabel;
  return (
    <header className="flex shrink-0 items-center gap-1 border-b px-2 py-1">
      {shownBackLabel === null ? null : (
        <Button
          aria-label={`Back to ${shownBackLabel}`}
          className="h-11 max-w-[40%] shrink-0 px-2"
          onClick={back}
          type="button"
          variant="ghost"
        >
          <ChevronLeft className="size-4" />
          <span className="truncate">{shownBackLabel}</span>
        </Button>
      )}
      <div className="min-w-0 flex-1 px-2">
        <RevealTitle
          name={name}
          size="sheet"
          title={title}
          titleRef={titleRef}
        />
        {status ? (
          <p
            className={cn("truncate text-xs", statusToneTextClass(status.tone))}
          >
            {status.text}
          </p>
        ) : null}
      </div>
      {openFullSheet === null || fullSheetLabel === undefined ? null : (
        <Button
          className="h-11 shrink-0 px-3"
          onClick={openFullSheet}
          type="button"
          variant="outline"
        >
          <Maximize2 className="size-4" />
          {fullSheetLabel}
        </Button>
      )}
      {shownBackLabel === null ? (
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

/**
 * The review sheet: one document for deciding to publish, and the same
 * document read-only for what a past version changed. On desktop it takes
 * Canvas Reveal's place and width over the right of the canvas, which stays
 * on screen beside it; below `md` it covers the screen. Only its own header
 * and footer stay put while its body scrolls as one surface.
 */

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useAtomValue } from "jotai";
import {
  ArrowLeft,
  Circle,
  History,
  Loader2,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useMemo,
  useRef,
  useState,
} from "react";
import { useExtensionCatalog } from "#src/components/extension-catalog-provider";
import { Button } from "#src/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#src/components/ui/dialog";
import { StatusPlaceholder } from "#src/components/workflow/status-placeholder";
import { WorkflowVersionUsage } from "#src/components/workflow/workflow-version-usage";
import { useAfterCommit, useAfterPaint } from "#src/hooks/effects";
import { useIsMobile } from "#src/hooks/use-mobile";
import { can } from "#src/lib/authorization";
import { insideKeyboardLayer, isSubmitChord } from "#src/lib/editor-shortcuts";
import { focusOpener } from "#src/lib/focus-return";
import { orpcQuery } from "#src/lib/rpc-query";
import { editsCountLine, workflowEdits } from "#src/lib/workflow-edits";
import { publicationReviewAtom } from "#src/lib/workflow-publication-review-store";
import {
  reviewPagesAtom,
  reviewScrollRequestAtom,
  reviewSheetContentAtom,
  type ReviewSheetContent,
} from "#src/lib/workflow-review-store";
import {
  currentWorkflowIdAtom,
  currentWorkflowModeAtom,
} from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";
import { WfGraphOperations } from "@wfgraph/shared/authorization/operations";
import type {
  WorkflowComparisonPayload,
  WorkflowVersionCursor,
  WorkflowVersionUsageItem,
} from "@wfgraph/shared/graph/publication-contracts";
import { cn } from "@wfgraph/shared/utils";
import { omitUndefined } from "@wfgraph/shared/utils/omit-undefined";
import { formatExactTime } from "@wfgraph/shared/utils/time";
import { REVEAL_INSET, revealWidth } from "../canvas-reveal/reveal-geometry";
import { rememberedRevealWidthAtom } from "../canvas-reveal/reveal-width-preference";
import { useRevealCanvasWidth } from "../canvas-reveal/use-reveal-width";
import { ReviewDocument, reviewEditElementId } from "./review-document";
import { usePublishReview } from "./use-publish-review";
import { type ReviewActions, useReviewActions } from "./use-review-actions";

/** A page's identity, which moves focus to its title when it changes. */
function contentKey(content: ReviewSheetContent | null): string {
  if (content === null) return "closed";
  if (content.kind === "version") return `version:${content.versionId}`;
  return content.kind;
}

export function ReviewSheet() {
  const content = useAtomValue(reviewSheetContentAtom);
  const workspace = useAtomValue(workflowWorkspaceViewAtom);
  const pages = useAtomValue(reviewPagesAtom);
  const draftReview = useAtomValue(publicationReviewAtom);
  const isMobile = useIsMobile();
  const canvasWidth = useRevealCanvasWidth();
  const rememberedWidth = useAtomValue(rememberedRevealWidthAtom);
  const actions = useReviewActions();
  const publish = usePublishReview();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const shown = content !== null && workspace === "draft" ? content : null;
  const key = contentKey(shown);

  // Each page opens with focus on its title and its body at the top. The
  // control that opened the sheet gets focus back when it closes.
  useAfterCommit(key, () => {
    if (shown === null) {
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
      return;
    }
    openerRef.current ??= focusOpener();
    scrollRef.current?.scrollTo({ top: 0 });
    titleRef.current?.focus({ preventScroll: true });
  });

  useReviewScroll(scrollRef, titleRef);

  if (shown === null) return null;

  // Back shows what lies beneath the top page: another page, or the draft's
  // review that Publish opened.
  const hasBack =
    pages.length > 1 || (pages.length === 1 && draftReview !== null);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      (event.target instanceof Element && insideKeyboardLayer(event.target))
    ) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      if (hasBack) actions.back();
      else if (shown.kind === "draft") publish.keepEditing();
      else actions.close();
      return;
    }
    if (
      shown.kind === "draft" &&
      isSubmitChord(event) &&
      !publish.isPublishing
    ) {
      event.preventDefault();
      publish.confirmPublish();
    }
  };
  const close = shown.kind === "draft" ? publish.keepEditing : actions.close;

  return (
    <aside
      aria-labelledby="review-sheet-title"
      className={cn(
        "z-30 flex flex-col overflow-clip bg-sidebar",
        isMobile
          ? "fixed inset-0 pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
          : "absolute rounded-xl border shadow-sm"
      )}
      data-slot="review-sheet"
      onKeyDown={onKeyDown}
      style={
        isMobile
          ? undefined
          : {
              top: REVEAL_INSET,
              right: REVEAL_INSET,
              bottom: REVEAL_INSET,
              width: revealWidth("browse", canvasWidth, rememberedWidth),
            }
      }
    >
      <SheetHeader
        actions={actions}
        content={shown}
        hasBack={hasBack}
        onClose={close}
        titleRef={titleRef}
      />
      <div
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-card [scrollbar-gutter:stable]"
        data-slot="review-sheet-body"
        ref={scrollRef}
      >
        <SheetBody actions={actions} content={shown} />
      </div>
      <SheetFooter actions={actions} content={shown} publish={publish} />
    </aside>
  );
}

/**
 * Scroll the edit of a card pressed on the canvas into view, once per press,
 * and move focus to that edit's title, or to the sheet's title when the card
 * has no edit. The press itself leaves focus on the canvas or the page, where
 * the sheet's Escape and Cmd+Enter do not reach.
 */
function useReviewScroll(
  scrollRef: RefObject<HTMLDivElement | null>,
  titleRef: RefObject<HTMLHeadingElement | null>
) {
  const request = useAtomValue(reviewScrollRequestAtom);
  useAfterPaint(request?.sequence ?? 0, () => {
    if (!request) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `#${CSS.escape(reviewEditElementId(request.nodeId))}`
    );
    element?.scrollIntoView?.({ block: "start" });
    const editTitle = element?.querySelector<HTMLElement>(
      '[data-slot="review-edit-title"]'
    );
    (editTitle ?? titleRef.current)?.focus({ preventScroll: true });
  });
}

function SheetHeader({
  content,
  actions,
  hasBack,
  onClose,
  titleRef,
}: {
  content: ReviewSheetContent;
  actions: ReviewActions;
  hasBack: boolean;
  onClose: () => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
}) {
  const catalog = useExtensionCatalog();
  const payload = sheetPayload(content);
  const title =
    content.kind === "draft"
      ? `Publish v${content.review.payload.proposedVersion}`
      : content.kind === "version"
        ? `What v${content.version} changed`
        : "Version history";
  const subtitle =
    content.kind === "history"
      ? null
      : payload
        ? editsCountLine(workflowEdits(payload, catalog))
        : content.kind === "version" && content.status === "error"
          ? "This version could not be read."
          : "Reading this version";
  return (
    <header className="shrink-0 border-b px-3 py-2">
      <div className="flex items-center gap-1">
        {hasBack ? (
          <Button
            aria-label="Back"
            onClick={actions.back}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft />
          </Button>
        ) : null}
        <h2
          className="min-w-0 flex-1 truncate px-1 font-semibold text-base outline-none"
          id="review-sheet-title"
          ref={titleRef}
          tabIndex={-1}
        >
          {title}
        </h2>
        {content.kind === "draft" && actions.canReadHistory ? (
          <Button
            onClick={actions.openHistory}
            size="sm"
            type="button"
            variant="ghost"
          >
            <History data-icon="inline-start" />
            Version history
          </Button>
        ) : null}
        <Button
          aria-label="Close"
          onClick={onClose}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <X />
        </Button>
      </div>
      {subtitle ? (
        <p
          className="px-1 pt-0.5 text-muted-foreground text-sm"
          data-slot="review-count"
        >
          {subtitle}
        </p>
      ) : null}
    </header>
  );
}

function sheetPayload(
  content: ReviewSheetContent
): WorkflowComparisonPayload | null {
  if (content.kind === "draft") return content.review.payload;
  if (content.kind === "version") return content.payload;
  return null;
}

function SheetBody({
  content,
  actions,
}: {
  content: ReviewSheetContent;
  actions: ReviewActions;
}) {
  if (content.kind === "history") {
    return <VersionHistoryList onOpen={actions.openVersion} />;
  }
  const payload = sheetPayload(content);
  if (payload === null) {
    return (
      <StatusPlaceholder
        label={
          content.kind === "version" && content.status === "error"
            ? "This version could not be read."
            : "Reading this version"
        }
      />
    );
  }
  return (
    <ReviewDocument onShowOnCanvas={actions.showOnCanvas} payload={payload} />
  );
}

function SheetFooter({
  content,
  actions,
  publish,
}: {
  content: ReviewSheetContent;
  actions: ReviewActions;
  publish: ReturnType<typeof usePublishReview>;
}) {
  if (content.kind === "history") return null;
  let line: ReactNode;
  let decision: ReactNode;
  if (content.kind === "draft") {
    const version = content.review.payload.proposedVersion;
    line = <PublishConsequence version={version} />;
    decision = (
      <>
        <Button
          disabled={publish.isPublishing}
          onClick={publish.keepEditing}
          type="button"
          variant="outline"
        >
          Keep editing
        </Button>
        <Button
          disabled={
            publish.isPublishing || !can(WfGraphOperations.workflowPublish.id)
          }
          onClick={publish.confirmPublish}
          type="button"
        >
          {publish.isPublishing ? (
            <Loader2
              className="animate-spin motion-reduce:animate-none"
              data-icon="inline-start"
            />
          ) : (
            <Upload data-icon="inline-start" />
          )}
          {publish.isPublishing ? "Publishing" : `Publish v${version}`}
        </Button>
      </>
    );
  } else {
    const { current } = content;
    line = (
      <span className="text-muted-foreground">
        {current
          ? `v${content.version} is the current version.`
          : `Restoring replaces the draft with v${content.version}.`}
      </span>
    );
    decision =
      actions.canRestore && !current ? (
        <RestoreVersionControl
          actions={actions}
          version={{ id: content.versionId, version: content.version }}
        />
      ) : null;
  }
  return (
    <footer className="flex shrink-0 flex-wrap items-center gap-2 border-t px-3 py-2 text-sm">
      <div className="min-w-0 flex-1 basis-48">{line}</div>
      <div className="flex shrink-0 gap-2">{decision}</div>
    </footer>
  );
}

/**
 * The consequence of publishing, in one line: the Published mode, that new
 * runs use the new version, and how many active runs stay on older ones.
 */
function PublishConsequence({ version }: { version: number }) {
  const mode = useAtomValue(currentWorkflowModeAtom);
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const canReadUsage = can(WfGraphOperations.workflowGetVersionUsage.id);
  const usage = useQuery({
    ...orpcQuery.workflow.getVersionUsage.queryOptions({
      input: { workflowId: workflowId ?? "" },
    }),
    enabled: Boolean(workflowId) && canReadUsage,
    staleTime: 30_000,
  });
  const left = canReadUsage
    ? runsLeftOnOlderVersions(usage.data?.items ?? [])
    : null;
  return (
    <p className="flex items-start gap-2 text-muted-foreground">
      {/* The dot the status strip's Published mode control wears: filled
          Amber for Test, an outline for Live. */}
      <Circle
        aria-hidden
        className={cn(
          "mt-1 size-2.5 shrink-0",
          mode === "test" && "fill-current text-warning"
        )}
      />
      <span>
        {mode === "test"
          ? `Test. New runs use v${version} and reach test recipients.`
          : `Live. New runs use v${version} and reach real recipients.`}
        {left ? ` ${left}` : null}
      </span>
    </p>
  );
}

/**
 * The sentence naming how many active runs stay on published versions once a
 * new one is published, or null when none does. A Draft run's snapshot is
 * never published, so it is not counted.
 */
export function runsLeftOnOlderVersions(
  items: readonly WorkflowVersionUsageItem[]
): string | null {
  const pinned = items.filter(
    (item) => item.kind === "published" && item.activeRunCount > 0
  );
  const runs = pinned.reduce((count, item) => count + item.activeRunCount, 0);
  if (runs === 0) return null;
  const versions = pinned
    .map((item) => item.version)
    .filter((version) => version !== null)
    .toSorted((left, right) => left - right)
    .map((version) => `v${version}`);
  const named = new Intl.ListFormat("en", { type: "conjunction" }).format(
    versions
  );
  return `${runs} active ${runs === 1 ? "run stays" : "runs stay"} on ${named}.`;
}

/**
 * Every published version, newest first, under the In use section where
 * active runs can be migrated. Choosing a version opens what it changed.
 */
function VersionHistoryList({
  onOpen,
}: {
  onOpen: (version: {
    id: string;
    version: number;
    isCurrent: boolean;
  }) => void;
}) {
  const workflowId = useAtomValue(currentWorkflowIdAtom);
  const canReadUsage = can(WfGraphOperations.workflowGetVersionUsage.id);
  const history = useInfiniteQuery({
    ...orpcQuery.workflow.getVersionHistory.infiniteOptions({
      // The contract declares `cursor` as an optional key, so the first page
      // omits it instead of sending `undefined`.
      input: (cursor: WorkflowVersionCursor | undefined) =>
        omitUndefined({ workflowId: workflowId ?? "", cursor }),
      initialPageParam: undefined as WorkflowVersionCursor | undefined,
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      enabled: Boolean(workflowId),
      meta: { errorMessage: "Unable to load version history" },
    }),
  });
  const items = useMemo(
    () => history.data?.pages.flatMap((page) => page.items) ?? [],
    [history.data]
  );
  return (
    <div data-testid="version-history">
      {canReadUsage && workflowId ? (
        <WorkflowVersionUsage workflowId={workflowId} />
      ) : null}
      <section aria-labelledby="all-versions-heading">
        <div className="border-b bg-muted/30 px-4 py-2">
          <h3
            className="font-medium text-muted-foreground text-xs"
            id="all-versions-heading"
          >
            All versions
          </h3>
        </div>
        {history.isPending ? (
          <div className="min-h-28">
            <StatusPlaceholder label="Loading version history" />
          </div>
        ) : history.isError ? (
          <div className="min-h-28">
            <StatusPlaceholder label="Unable to load version history" />
          </div>
        ) : (
          <div className="divide-y">
            {items.map((item) => (
              <button
                className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-muted"
                key={item.id}
                onClick={() => onOpen(item)}
                type="button"
              >
                <span className="font-medium text-sm">v{item.version}</span>
                <span className="text-right text-muted-foreground text-xs">
                  {item.isCurrent ? "Current · " : ""}
                  {formatExactTime(new Date(item.publishedAt))}
                </span>
              </button>
            ))}
            {history.hasNextPage ? (
              <div className="p-3">
                <Button
                  className="w-full"
                  disabled={history.isFetchingNextPage}
                  onClick={() => void history.fetchNextPage()}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  {history.isFetchingNextPage ? "Loading" : "Load more"}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * "Restore vN as draft", where Publish sits on the draft's review, and the
 * confirmation it opens.
 */
function RestoreVersionControl({
  actions,
  version,
}: {
  actions: ReviewActions;
  version: { id: string; version: number };
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        disabled={actions.isRestoring}
        onClick={() => setOpen(true)}
        type="button"
      >
        <RotateCcw data-icon="inline-start" />
        Restore v{version.version} as draft
      </Button>
      <Dialog onOpenChange={setOpen} open={open}>
        <DialogContent showCloseButton={!actions.isRestoring}>
          <DialogHeader>
            <DialogTitle>Restore v{version.version} as draft?</DialogTitle>
            <DialogDescription>
              This replaces the current draft with v{version.version}. The
              published version stays the same until you publish again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              disabled={actions.isRestoring}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              disabled={actions.isRestoring}
              onClick={() => actions.restore(version.id)}
              type="button"
            >
              {actions.isRestoring ? "Restoring" : "Restore as draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * The review sheet: the one document that shows what publishing changes, and
 * what each past version changed. Its first page is the draft's review, which
 * `workflow-publication-review-store` owns because Publish opens it. Version
 * history and a past version open as pages above it, or on their own from the
 * Actions menu. While the sheet is open the Draft canvas draws the comparison
 * the sheet shows and refuses every edit. Everything here is scoped by
 * workflow, so a late answer never lands in another workflow's sheet.
 */

import { atom } from "jotai";
import type { WorkflowComparisonPayload } from "@wfgraph/shared/graph/publication-contracts";
import {
  buildComparisonDisplayGraph,
  type ComparisonDisplayGraph,
} from "#src/lib/workflow-comparison";
import {
  publicationReviewAtom,
  publicationReviewSessionAtom,
  type ReadyPublicationReview,
} from "#src/lib/workflow-publication-review-store";
import { currentWorkflowIdAtom } from "#src/lib/workflow-save-store";
import { workflowWorkspaceViewAtom } from "#src/lib/workflow-ui-store";

/**
 * A page above the draft's review: the list of published versions, or what
 * one published version changed. `current` says the version is the one the
 * workflow publishes now. `payload` is null until its comparison arrives, and
 * stays null when the request fails.
 */
export type ReviewPage =
  | { kind: "history" }
  | {
      kind: "version";
      versionId: string;
      version: number;
      current: boolean;
      status: "loading" | "ready" | "error";
      payload: WorkflowComparisonPayload | null;
    };

/** What the sheet shows: a page, or the draft's review below every page. */
export type ReviewSheetContent =
  | ReviewPage
  | { kind: "draft"; review: ReadyPublicationReview };

const reviewPagesStateAtom = atom<
  Readonly<Record<string, readonly ReviewPage[]>>
>({});

const NO_PAGES: readonly ReviewPage[] = [];

/** The pages open above the draft's review in the workflow in the editor. */
export const reviewPagesAtom = atom((get): readonly ReviewPage[] => {
  const workflowId = get(currentWorkflowIdAtom);
  return workflowId
    ? (get(reviewPagesStateAtom)[workflowId] ?? NO_PAGES)
    : NO_PAGES;
});

/** What the sheet shows, or null while it is closed. */
export const reviewSheetContentAtom = atom((get): ReviewSheetContent | null => {
  const top = get(reviewPagesAtom).at(-1);
  if (top) return top;
  const review = get(publicationReviewAtom);
  return review ? { kind: "draft", review } : null;
});

/**
 * Whether the sheet is on screen. It belongs to Draft, so another workspace
 * never shows it.
 */
export const isReviewSheetShownAtom = atom(
  (get) =>
    get(reviewSheetContentAtom) !== null &&
    get(workflowWorkspaceViewAtom) === "draft"
);

/**
 * Whether the sheet is open, or Publish is preparing the draft's review. The
 * canvas refuses edits for as long as this holds.
 */
export const isReviewOpenAtom = atom(
  (get) =>
    get(reviewPagesAtom).length > 0 ||
    get(publicationReviewSessionAtom) !== null
);

/**
 * The comparison the sheet shows and the canvas draws: the past version on
 * top, or else the draft's review. Null while neither has arrived.
 */
export const reviewComparisonAtom = atom(
  (get): WorkflowComparisonPayload | null => {
    const top = get(reviewPagesAtom).at(-1);
    if (top?.kind === "version") return top.payload;
    return get(publicationReviewAtom)?.payload ?? null;
  }
);

/**
 * The read-only graph the Draft canvas draws while the sheet shows a
 * comparison, separate from the draft's own nodes and edges.
 */
export const reviewDisplayGraphAtom = atom(
  (get): ComparisonDisplayGraph | null => {
    const payload = get(reviewComparisonAtom);
    return payload && get(workflowWorkspaceViewAtom) === "draft"
      ? buildComparisonDisplayGraph(payload)
      : null;
  }
);

/** Open `page` on top of a workflow's sheet. History never opens twice. */
export const openReviewPageAtom = atom(
  null,
  (get, set, input: { workflowId: string; page: ReviewPage }): void => {
    const pages = get(reviewPagesStateAtom)[input.workflowId] ?? NO_PAGES;
    if (input.page.kind === "history" && pages.at(-1)?.kind === "history") {
      return;
    }
    set(reviewPagesStateAtom, (state) => ({
      ...state,
      [input.workflowId]: [...pages, input.page],
    }));
  }
);

/** Remove the top page, which shows the page or the review beneath it. */
export const closeReviewPageAtom = atom(
  null,
  (get, set, workflowId: string) => {
    const pages = get(reviewPagesStateAtom)[workflowId] ?? NO_PAGES;
    set(reviewPagesStateAtom, (state) => ({
      ...state,
      [workflowId]: pages.slice(0, -1),
    }));
  }
);

/** Remove every page of a workflow's sheet. */
export const clearReviewPagesAtom = atom(
  null,
  (_get, set, workflowId?: string) => {
    set(reviewPagesStateAtom, (state) => {
      if (workflowId === undefined) return {};
      const { [workflowId]: _cleared, ...remaining } = state;
      return remaining;
    });
  }
);

/**
 * Settle the request of a version page. A page closed since the request
 * started is left closed.
 */
export const settleVersionReviewAtom = atom(
  null,
  (
    _get,
    set,
    input: {
      workflowId: string;
      versionId: string;
      payload: WorkflowComparisonPayload | null;
    }
  ) => {
    set(reviewPagesStateAtom, (state) => {
      const pages = state[input.workflowId];
      if (!pages) return state;
      return {
        ...state,
        [input.workflowId]: pages.map((page) =>
          page.kind === "version" &&
          page.versionId === input.versionId &&
          page.status === "loading"
            ? {
                ...page,
                status: input.payload ? "ready" : "error",
                payload: input.payload,
              }
            : page
        ),
      };
    });
  }
);

/**
 * The step whose card the sheet points at, which the canvas draws with the
 * selection halo while the sheet is open. Pointing never moves the camera.
 */
export const reviewHighlightAtom = atom<string | null>(null);

/**
 * A changed card the reader pressed while the sheet is open, which the sheet
 * answers once by scrolling that step's edit into view. `sequence` tells two
 * presses of the same card apart.
 */
export const reviewScrollRequestAtom = atom<{
  nodeId: string;
  sequence: number;
} | null>(null);

export const requestReviewScrollAtom = atom(
  null,
  (get, set, nodeId: string) => {
    set(reviewScrollRequestAtom, {
      nodeId,
      sequence: (get(reviewScrollRequestAtom)?.sequence ?? 0) + 1,
    });
  }
);

/**
 * A workflow whose route asked for the review sheet, such as a link to the
 * Changes view the editor once had. The toolbar answers it once the workflow
 * is open, the way Publish does, and clears it.
 */
export const requestedReviewAtom = atom<string | null>(null);

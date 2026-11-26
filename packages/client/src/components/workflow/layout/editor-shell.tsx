import type { ReactNode } from "react";

/**
 * The workflow editor's frame: the page it is inset on, the shadow that lifts
 * it, and the shell that clips its contents to the rounded corner. `children`
 * is the toolbar and everything below it. Nothing from the page root down to
 * the shell can scroll, so a focus move or a `scrollIntoView` inside the editor
 * never carries the toolbar or the canvas sideways.
 */
export function EditorShell({ children }: { children: ReactNode }) {
  return (
    // The page the shell is inset on. It covers the viewport, and padding
    // rather than a margin on the shell keeps the inset inside it.
    //
    // It is fixed to the viewport so that no scroll of the document can move
    // the editor. `html` and `body` are `overflow: hidden`, which hides their
    // scrollbars but still lets `scrollIntoView` or a focus move scroll them;
    // a fixed box stays where it is whatever the document's scroll position.
    // The shell inside is positioned too, so it stays the containing block
    // every absolute child of the editor measures against.
    <div
      className="fixed inset-0 bg-page p-[var(--editor-inset)]"
      data-slot="editor-page"
    >
      {/* The one shadow lifting the editor off the page, on its own element
          because the shell below is clipped by a `clip-path`, which takes an
          element's own box-shadow away with everything else outside the shape.
          The frame carries the shadow outside that clip and the same radius, so
          the shell fills it exactly and the two curves are one curve. */}
      <div className="size-full bg-background md:rounded-xl md:shadow-xs">
        {/* The editor shell: the toolbar over the canvas and the status strip.

            Three things hold the contents inside the corner, and all three are
            needed. The radius and `overflow-clip` clip an ordinary child.
            They do not clip a composited one: a phone sheet animates on
            `transform`, which puts it on its own layer, and a composited layer
            paints its square corner over the rounded one and takes the page
            margin's hit region with it. The `clip-path` is the form of the
            clip that layer cannot escape.

            The shell uses `overflow-clip` because a clipped box is not a scroll
            container. Focusing a control inside a sheet while it slides in
            from past an edge scrolls the nearest scroll container to reach it,
            and an `overflow-hidden` shell would be that container, carrying the
            toolbar and canvas sideways with it.

            `clip-path` rather than a transform, `contain: paint` or a mask,
            each of which would also clip a composited child: those three make
            this element the containing block for a `position: fixed`
            descendant, which would move any the editor ever holds. `clip-path`
            leaves position alone. It does clip a fixed descendant's painting
            and hit region, like everything else in here, so a popup inside the
            editor still has to be portalled out to escape the corner, which is
            what every one of them already does. */}
        <div
          className="relative flex size-full flex-col overflow-clip md:rounded-xl md:border md:[clip-path:inset(0_round_var(--editor-shell-radius))]"
          data-slot="editor-shell"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

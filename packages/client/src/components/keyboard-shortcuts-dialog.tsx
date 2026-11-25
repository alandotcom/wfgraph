/**
 * The keyboard shortcut reference: every shortcut the app binds, grouped by
 * where it works, with a search field that filters the rows by what they do.
 * "?" opens it from anywhere outside a text field, and the command palette and
 * the editor's Actions menu open it through `shortcutReferenceOpenAtom`.
 */

import { useAtom } from "jotai";
import { Fragment, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#src/components/ui/dialog";
import { Input } from "#src/components/ui/input";
import { Kbd } from "#src/components/ui/kbd";
import { useDomEvent } from "#src/hooks/effects";
import { editorChordAllowed } from "#src/lib/editor-shortcuts";
import { normalizeSearchText } from "#src/lib/palette-search";
import {
  currentPlatform,
  isApplePlatform,
  SHORTCUT_REFERENCE_KEY,
  shortcutReference,
} from "#src/lib/shortcut-label";
import { shortcutReferenceOpenAtom } from "#src/lib/shortcut-reference-store";

export function KeyboardShortcutsDialog() {
  const [open, setOpen] = useAtom(shortcutReferenceOpenAtom);

  // "?" with no modifier but the Shift some keyboards need to type it. A text
  // field keeps the character, and an open dialog or menu keeps the keyboard.
  useDomEvent(document, "keydown", (event) => {
    if (
      event.key !== SHORTCUT_REFERENCE_KEY ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      !editorChordAllowed(event, { inTextFields: false })
    ) {
      return;
    }
    event.preventDefault();
    setOpen(true);
  });

  if (!open) {
    return null;
  }
  return <ShortcutReference onClose={() => setOpen(false)} />;
}

function ShortcutReference({ onClose }: { onClose: () => void }) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const sections = useMemo(
    () => shortcutReference(isApplePlatform(currentPlatform())),
    []
  );
  const needle = normalizeSearchText(query);
  const shown = sections
    .map((section) => ({
      ...section,
      entries: section.entries.filter((entry) =>
        normalizeSearchText(`${section.title} ${entry.label}`).includes(needle)
      ),
    }))
    .filter((section) => section.entries.length > 0);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
      open
    >
      <DialogContent
        className="max-h-[min(40rem,calc(100dvh-4rem))] grid-rows-[auto_auto_minmax(0,1fr)] sm:max-w-md"
        initialFocus={searchRef}
      >
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription className="sr-only">
            Every shortcut, grouped by where it works.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Search shortcuts"
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search shortcuts"
          ref={searchRef}
          value={query}
        />
        <div className="-mx-4 min-h-0 overflow-y-auto px-4">
          {shown.length === 0 ? (
            <p className="py-6 text-center text-muted-foreground">
              No shortcut matches that.
            </p>
          ) : (
            shown.map((section) => (
              <section aria-label={section.title} key={section.title}>
                <h3 className="pt-3 pb-1 font-medium text-muted-foreground">
                  {section.title}
                </h3>
                <dl>
                  {section.entries.map((entry) => (
                    <div
                      className="flex min-h-8 items-center justify-between gap-3 border-b py-1 last:border-b-0"
                      key={entry.label}
                    >
                      <dt>{entry.label}</dt>
                      <dd className="flex shrink-0 items-center gap-1 text-muted-foreground">
                        {entry.keys.map((key, index) => (
                          <Fragment key={key}>
                            {index > 0 ? <span>or</span> : null}
                            <Kbd>{key}</Kbd>
                          </Fragment>
                        ))}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

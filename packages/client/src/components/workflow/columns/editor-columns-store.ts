/**
 * The editor's two side columns, the outline on the left and details on the
 * right: each one's width and whether the person collapsed it, kept in one
 * cookie across reloads, and how the three window widths turn those choices
 * into what shows. A selection never writes here, so only the person's own
 * collapse and resize controls change the columns.
 */

import { atom } from "jotai";
import { Option, Schema } from "effect";
import { readCookie, writeCookie } from "#src/lib/preference-cookies";
import { detailsTabAtom } from "#src/lib/workflow-ui-store";

export type ColumnSide = "outline" | "details";

/** The narrowest, widest and default width of each column, in CSS pixels. */
export const COLUMN_WIDTHS: Readonly<
  Record<ColumnSide, { min: number; max: number; defaultWidth: number }>
> = {
  outline: { min: 240, max: 480, defaultWidth: 340 },
  details: { min: 340, max: 560, defaultWidth: 400 },
};

/**
 * What one person chose for one column. An undefined `width` is the default
 * width.
 */
export type ColumnPreference = {
  width: number | undefined;
  collapsed: boolean;
};

export type ColumnPreferences = Readonly<Record<ColumnSide, ColumnPreference>>;

const DEFAULT_PREFERENCES: ColumnPreferences = {
  outline: { width: undefined, collapsed: false },
  details: { width: undefined, collapsed: false },
};

const COLUMNS_COOKIE = "editor-columns";

/** The cookie's JSON object. Each column's fields are checked on their own. */
const cookieObject = Schema.fromJsonString(
  Schema.Struct({
    outline: Schema.optionalKey(Schema.Unknown),
    details: Schema.optionalKey(Schema.Unknown),
  })
);
const decodeCookieObject = Schema.decodeUnknownOption(cookieObject);
const decodeColumnObject = Schema.decodeUnknownOption(
  Schema.Struct({
    width: Schema.optionalKey(Schema.Unknown),
    collapsed: Schema.optionalKey(Schema.Unknown),
  })
);
const decodeCollapsed = Schema.decodeUnknownOption(Schema.Boolean);

function decodeWidth(side: ColumnSide, value: unknown): number | undefined {
  const { min, max } = COLUMN_WIDTHS[side];
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(
      Schema.Finite.check(
        Schema.isInt(),
        Schema.isBetween({ minimum: min, maximum: max })
      )
    )(value)
  );
}

function readColumn(side: ColumnSide, stored: unknown): ColumnPreference {
  const column = Option.getOrUndefined(decodeColumnObject(stored));
  return {
    width: decodeWidth(side, column?.width),
    collapsed:
      Option.getOrUndefined(decodeCollapsed(column?.collapsed)) ?? false,
  };
}

/**
 * The column preferences an `editor-columns` cookie value holds. A column, a
 * width or a collapsed flag that is absent or malformed reads as its default,
 * and so does a width outside the column's range.
 */
export function readColumnPreferences(
  cookie: string | undefined
): ColumnPreferences {
  if (cookie === undefined) {
    return DEFAULT_PREFERENCES;
  }
  let json: string;
  try {
    json = decodeURIComponent(cookie);
  } catch {
    return DEFAULT_PREFERENCES;
  }
  const stored = Option.getOrUndefined(decodeCookieObject(json));
  if (stored === undefined) {
    return DEFAULT_PREFERENCES;
  }
  return {
    outline: readColumn("outline", stored.outline),
    details: readColumn("details", stored.details),
  };
}

/** The cookie value holding `preferences`. */
export function columnPreferencesCookie(
  preferences: ColumnPreferences
): string {
  return encodeURIComponent(JSON.stringify(preferences));
}

/** `width` held inside the range of `side`, rounded to a whole pixel. */
export function clampColumnWidth(side: ColumnSide, width: number): number {
  const { min, max } = COLUMN_WIDTHS[side];
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** The width `side` shows at. */
export function columnWidth(
  side: ColumnSide,
  preferences: ColumnPreferences
): number {
  return preferences[side].width ?? COLUMN_WIDTHS[side].defaultWidth;
}

const columnPreferencesStateAtom = atom<ColumnPreferences>(
  readColumnPreferences(readCookie(COLUMNS_COOKIE))
);

/** The person's column choices, including a width a resize in progress shows. */
export const columnPreferencesAtom = atom((get) =>
  get(columnPreferencesStateAtom)
);

function writePreference(
  preferences: ColumnPreferences,
  side: ColumnSide,
  update: Partial<ColumnPreference>
): ColumnPreferences {
  return { ...preferences, [side]: { ...preferences[side], ...update } };
}

/** Show `width` for `side` while a drag or a key resize is in progress. */
export const resizeColumnAtom = atom(
  null,
  (get, set, input: { side: ColumnSide; width: number }) => {
    set(
      columnPreferencesStateAtom,
      writePreference(get(columnPreferencesStateAtom), input.side, {
        width: clampColumnWidth(input.side, input.width),
      })
    );
  }
);

/** Keep the preferences in the cookie, as a finished resize or toggle does. */
export const saveColumnPreferencesAtom = atom(null, (get) => {
  writeCookie(
    COLUMNS_COOKIE,
    columnPreferencesCookie(get(columnPreferencesStateAtom))
  );
});

/** Forget the width chosen for `side` and keep the default in the cookie. */
export const resetColumnWidthAtom = atom(null, (get, set, side: ColumnSide) => {
  set(
    columnPreferencesStateAtom,
    writePreference(get(columnPreferencesStateAtom), side, {
      width: undefined,
    })
  );
  set(saveColumnPreferencesAtom);
});

/** Collapse `side`, or bring it back, and keep the choice in the cookie. */
export const setColumnCollapsedAtom = atom(
  null,
  (get, set, input: { side: ColumnSide; collapsed: boolean }) => {
    set(
      columnPreferencesStateAtom,
      writePreference(get(columnPreferencesStateAtom), input.side, {
        collapsed: input.collapsed,
      })
    );
    set(saveColumnPreferencesAtom);
  }
);

/**
 * Whether a phone shows the canvas, which the toolbar's Map control chooses,
 * in place of the outline. It is not kept across reloads.
 */
export const phoneShowsMapAtom = atom(false);

/**
 * Whether details floats over the right of the canvas while the details
 * column is not docked. A selection opens it and clearing the selection closes
 * it; its close control, Escape inside it, and `]` close it too. It is not kept
 * across reloads, and a docked details column ignores it.
 */
export const detailsFloatOpenAtom = atom(false);

/**
 * How many times "Find a step" has asked for the outline's filter field. The
 * editor columns focus the field after each request commits, once the outline
 * it brought into view has mounted.
 */
export const outlineFilterFocusRequestAtom = atom(0);

/**
 * The editor's three window widths. `wide` is 1360px and wider, where both side
 * columns dock. `medium` is 900px to 1359px, where the outline docks and
 * details floats over the canvas. `compact` is narrower than 900px, where the
 * outline is the screen.
 */
export type EditorLayout = "wide" | "medium" | "compact";

/**
 * What one side column shows: docked beside the canvas, or a rail. Details
 * that is not docked floats over the right of the canvas while it is open.
 */
export type ColumnShape = "docked" | "rail" | "floating";

/**
 * What each side column shows in `layout`. The outline docks unless the
 * person collapsed it. Details docks in `wide` unless the person collapsed it;
 * in `medium` it never docks, because the canvas keeps room for one docked
 * column, which is the outline's. Details that is not docked is a rail, and
 * floats while `detailsFloatOpen`. `compact` has no side columns of its own.
 */
export function columnShapes(input: {
  layout: EditorLayout;
  preferences: ColumnPreferences;
  detailsFloatOpen: boolean;
}): Record<ColumnSide, ColumnShape> {
  const { preferences } = input;
  const outline: ColumnShape = preferences.outline.collapsed
    ? "rail"
    : "docked";
  if (input.layout === "wide" && !preferences.details.collapsed) {
    return { outline, details: "docked" };
  }
  return { outline, details: input.detailsFloatOpen ? "floating" : "rail" };
}

/**
 * What the details column's control, `]` and its command do in `layout`: in
 * `wide` they collapse or dock the column, and in `medium` they open or close
 * the floating details.
 */
export function detailsToggle(input: {
  layout: EditorLayout;
  shape: ColumnShape;
}): "collapse" | "dock" | "float" | "close-float" {
  if (input.layout === "wide") {
    return input.shape === "docked" ? "collapse" : "dock";
  }
  return input.shape === "floating" ? "close-float" : "float";
}

/**
 * Show one tab of the details column, for a command that asks for that tab by
 * name: "Describe it to the agent", or an issue's Edit. Details that is not
 * docked floats in to show it.
 */
const showDetailsColumnTabAtom = atom(
  null,
  (_get, set, tab: "details" | "agent") => {
    set(detailsTabAtom, tab);
    set(detailsFloatOpenAtom, true);
  }
);

/** Show the build agent in the details column. */
export const showAgentTabAtom = atom(null, (_get, set) => {
  set(showDetailsColumnTabAtom, "agent");
});

/** Show the Details tab of the details column. */
export const showDetailsTabAtom = atom(null, (_get, set) => {
  set(showDetailsColumnTabAtom, "details");
});

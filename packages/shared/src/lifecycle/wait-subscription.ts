/**
 * What a Wait node holds, as data.
 *
 * A node's config is an open bag, so this is the one definition of the slice of
 * it the Wait node owns: the engine and the editor read the same shape rather
 * than each picking keys out of the bag. The two modes are the two things a
 * builder can mean -- resume on a clock, or resume when an Event arrives that
 * satisfies a match.
 */

import { Result, Schema } from "effect";
import type { ValueTargetType } from "#src/graph/value-targets";
import { NonEmptyTrimmedString, readAs } from "#src/types/schema";
import { formatSchemaFailure } from "#src/types/schema-message";

/**
 * One Event a Wait node parks on, with the predicate that decides whether an
 * arrival belongs to this run.
 *
 * `event` is an Event name the app declares. This schema takes any non-empty
 * string, because it has no catalog to compare against; the save is what holds
 * a name to the catalog, because a wait on an Event nothing sends can only time
 * out. `match` is the serialized `ConditionModel` the Condition node already
 * stores, evaluated against the arriving payload rather than against merged
 * node outputs. A subscription with no match resumes on the next occurrence of
 * that Event, whatever it carries.
 */
export const eventSubscriptionSchema = Schema.Struct({
  event: NonEmptyTrimmedString,
  /** Serialized `ConditionModel`, the same string the Condition node stores. */
  match: Schema.optional(Schema.String),
});

export type EventSubscription = typeof eventSubscriptionSchema.Type;

const waitForSchema = Schema.mutable(
  Schema.Array(eventSubscriptionSchema)
).check(Schema.isMinLength(1));

/**
 * The Wait node's config, both modes in one schema.
 *
 * Every key a mode reads is `optional` because the engine resolves templates
 * into every declared config key, so a field the builder left blank arrives
 * present and holding `undefined`.
 *
 * `waitMode` is optional for a different reason: absence and `"delay"` mean the
 * same thing to a builder, because the selector opens on "Wait for time" and
 * only a deliberate choice writes the key. `readWaitConfig` applies that
 * default. What absence does not admit is the retired third mode -- a node
 * holding `waitMode: "hook"` fails this decode, which is the intended end of
 * it.
 */
export const waitConfigSchema = Schema.Struct({
  waitMode: Schema.optional(Schema.Literals(["delay", "event"])),

  // Event mode.
  waitFor: Schema.optional(waitForSchema),
  /**
   * Required in event mode, enforced by the save rule rather than by this key.
   * A wait with no timeout is an immortal Execution: it holds a row, an Inngest
   * function, and a place in the run list until someone notices. The editor
   * writes 7d when the mode is chosen, which a builder can raise.
   */
  waitTimeout: Schema.optional(Schema.String),
  waitTimeoutBehavior: Schema.optional(Schema.Literals(["continue", "skip"])),

  // Delay mode.
  waitDuration: Schema.optional(Schema.String),
  waitUntil: Schema.optional(Schema.String),
  waitOffset: Schema.optional(Schema.String),
  waitGateMode: Schema.optional(
    Schema.Literals(["off", "require_actual_wait"])
  ),
  waitAllowedHoursMode: Schema.optional(Schema.String),
  waitAllowedStartTime: Schema.optional(Schema.String),
  waitAllowedEndTime: Schema.optional(Schema.String),
  waitTimezone: Schema.optional(Schema.String),
});

export type WaitConfig = typeof waitConfigSchema.Type;

/** Which of the node's shapes reads a key: one mode, and for delay one timing. */
type WaitValueOwner =
  | { mode: "event" }
  | { mode: "delay"; timing: "duration" | "until" };

/**
 * What each of the Wait node's time keys is read as, who reads it, and whether a
 * blank one stops the node.
 *
 * Data because three readers ask: the panel draws the input from it, the mode
 * selectors clear what the shape they left owned, and the save refuses a token
 * whose field the key's parser cannot read. Ownership is part of it because a
 * key belongs to one shape of the node -- the engine reads the timeout only
 * while parked on an Event -- so a rule that ignored it would police a value no
 * run consults.
 */
export const WAIT_VALUE_TARGETS = {
  waitDuration: {
    type: "duration",
    required: true,
    owner: { mode: "delay", timing: "duration" },
  },
  waitUntil: {
    type: "timestamp",
    required: true,
    owner: { mode: "delay", timing: "until" },
  },
  // A wait with no offset writes a blank, so an absent value is what it means.
  waitOffset: {
    type: "duration",
    required: false,
    owner: { mode: "delay", timing: "until" },
  },
  waitTimeout: {
    type: "duration",
    required: true,
    owner: { mode: "event" },
  },
} as const satisfies Record<
  string,
  { type: ValueTargetType; required: boolean; owner: WaitValueOwner }
>;

export type WaitValueTargetKey = keyof typeof WAIT_VALUE_TARGETS;

/**
 * Every key, in panel order. Written out rather than read off the object,
 * because `Object.keys` answers `string[]` and narrowing it back is an assertion
 * the compiler cannot check.
 */
const WAIT_VALUE_TARGET_KEYS: readonly WaitValueTargetKey[] = [
  "waitDuration",
  "waitUntil",
  "waitOffset",
  "waitTimeout",
];

/**
 * Which timing the delay mode is on, with absence read off the config: a node
 * carrying a target date is on `until`, whatever it says.
 */
export function readWaitDelayTiming(
  config: Record<string, unknown>
): "duration" | "until" {
  const declared = config.waitDelayTimingMode;
  if (declared === "until" || declared === "duration") {
    return declared;
  }

  return typeof config.waitUntil === "string" && config.waitUntil.trim()
    ? "until"
    : "duration";
}

/**
 * The keys this node's current shape actually reads.
 *
 * A key the shape does not own is left out rather than reported: the engine
 * ignores it, and the input a builder would fix it in is off screen.
 */
export function waitValueKeysIn(
  config: Record<string, unknown>
): WaitValueTargetKey[] {
  const mode = config.waitMode === "event" ? "event" : "delay";
  const timing = readWaitDelayTiming(config);

  return WAIT_VALUE_TARGET_KEYS.filter((key) => {
    const { owner } = WAIT_VALUE_TARGETS[key];
    return owner.mode === "event"
      ? mode === "event"
      : mode === "delay" && owner.timing === timing;
  });
}

/** Those same keys with what each expects, for a reader that needs the target. */
export function waitValueTargetsFor(
  config: Record<string, unknown>
): Partial<
  Record<WaitValueTargetKey, (typeof WAIT_VALUE_TARGETS)[WaitValueTargetKey]>
> {
  return Object.fromEntries(
    waitValueKeysIn(config).map((key) => [key, WAIT_VALUE_TARGETS[key]])
  );
}

/** The keys a node leaving this shape should stop carrying. */
export function waitValueKeysNotIn(
  config: Record<string, unknown>
): WaitValueTargetKey[] {
  const kept = new Set<WaitValueTargetKey>(waitValueKeysIn(config));

  return WAIT_VALUE_TARGET_KEYS.filter((key) => !kept.has(key));
}

/** The mode a Wait node is in, with absence reading as the selector's default. */
export type WaitMode = "delay" | "event";

/**
 * What the editor writes the moment a builder picks "Wait for an event".
 *
 * Long enough that the common case costs no thought, short enough that no wait
 * outlives the workflow it was written for.
 */
export const DEFAULT_WAIT_TIMEOUT = "7d";

export type WaitConfigReadResult =
  | { valid: true; config: WaitConfig; waitMode: WaitMode }
  | { valid: false; error: string };

const decodeWaitConfig = Schema.decodeUnknownResult(waitConfigSchema);

/**
 * The wait's own keys off a node's config bag, or the sentence saying why not.
 *
 * The bag carries an action's own keys beside these, so the decode leaves unknown
 * keys where it found them: this shape describes one action's slice of a config,
 * not a closed wire payload.
 */
export function readWaitConfig(
  config: Record<string, unknown>
): WaitConfigReadResult {
  const decoded = decodeWaitConfig(config);
  if (Result.isFailure(decoded)) {
    return { valid: false, error: formatSchemaFailure(decoded.failure.issue) };
  }

  return {
    valid: true,
    config: decoded.success,
    waitMode: decoded.success.waitMode ?? "delay",
  };
}

const readSubscriptions = readAs(
  Schema.mutable(Schema.Array(eventSubscriptionSchema))
);

/**
 * The subscriptions a node's config carries, for the readers that render or index
 * a graph rather than run it.
 *
 * Answers an empty list where `readWaitConfig` answers a sentence, and reads
 * `waitFor` alone so that a node broken elsewhere in its config still lists the
 * Events its parked runs are owed.
 */
export function readWaitSubscriptions(
  config: Record<string, unknown> | undefined
): EventSubscription[] {
  return readSubscriptions(config?.waitFor) ?? [];
}

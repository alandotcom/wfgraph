/**
 * How every node config form writes back to the node it is editing.
 *
 * A form hands back a patch: the set of config keys that change together. That
 * shape exists so a rule spanning more than one key stays a single write. A
 * Condition node has such a rule — its stored model and the expression compiled
 * from it are one edit — and expressing that as two sequential one-key writes is
 * what lets the pair drift apart.
 *
 * Keys absent from the patch keep whatever the node already stores.
 */
export type NodeConfigPatch = Record<string, unknown>;

/** The write half of a config form's interface. */
export type UpdateNodeConfig = (patch: NodeConfigPatch) => void;

/**
 * How a message a person reads names a step: by its number in the outline,
 * where the caller knows the graph, and by its label, as "Step 2 "Get User"".
 * A step with no label of its own is named by its number alone, or by what
 * kind of node it is. A node id and the word "Node" never appear.
 */

/** The name a message gives a node with no label: what its card is titled. */
export function unlabelledStepName(node: { data: { type: string } }): string {
  switch (node.data.type) {
    case "lifecycle":
      return "Start";
    case "group":
      return "Group";
    default:
      return "Action";
  }
}

/** A node's own trimmed label, else what its card is titled; never its id. */
export function stepLabelForMessage(node: {
  data: { type: string; label?: string | undefined };
}): string {
  return node.data.label?.trim() || unlabelledStepName(node);
}

/**
 * A step as the subject of a message: "Step 2 "Get User"", "Step 2" for a step
 * with no name, "Get User" in quotes without a number, or "A step".
 */
export function stepName(label: string | undefined, number?: number): string {
  if (label === undefined) {
    return number === undefined ? "A step" : `Step ${number}`;
  }
  return number === undefined ? `"${label}"` : `Step ${number} "${label}"`;
}

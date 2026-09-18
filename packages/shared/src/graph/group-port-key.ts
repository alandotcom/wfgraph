/**
 * The text key naming one Group port inside a painted id, such as a collapsed
 * card's outlet handle or a focused Group's boundary stub. Two different ports
 * never share a key, and every node id and handle the graph schema accepts has
 * one, including a string holding a lone UTF-16 surrogate. A key is an opaque
 * React Flow id and no caller reads a port back out of it.
 */

import type { GroupPort } from "#src/graph/group-boundary";

/**
 * Replaces each `%` with `%25` and each `/` with `%2F`, so the result holds no
 * slash and two different strings never share a result. Every other character,
 * a lone surrogate included, is kept as it is, which leaves an ordinary id
 * readable and adds no quote that would break a React Flow handle selector.
 */
function escapePortPart(text: string): string {
  return text.replace(/[%/]/g, (character) =>
    character === "%" ? "%25" : "%2F"
  );
}

/**
 * The escaped node id, then a slash and the escaped handle when the port names
 * one. An escaped part holds no slash, so the first slash always separates the
 * node id from the handle.
 */
export function groupPortKey(port: GroupPort): string {
  const nodeId = escapePortPart(port.nodeId);
  return port.handle === null
    ? nodeId
    : `${nodeId}/${escapePortPart(port.handle)}`;
}

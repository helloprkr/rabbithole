/**
 * Author colors for the LOCAL canvas (Warren patch 3).
 *
 * MIRROR — source of truth: warren's `src/publish/team-palette.ts`. The fork and
 * warren live in separate repos and cannot import across the boundary, so the
 * palette is duplicated here verbatim. If warren's palette changes, change it here
 * too; keeping the constant in this ONE fork module means nothing WITHIN the fork
 * drifts (the node transport derives colors from here; the browser only consumes
 * the derived map shipped in hydration).
 *
 * The palette is the **Okabe–Ito** colorblind-safe qualitative palette (Okabe &
 * Ito 2008, "Color Universal Design"), reordered so the highest-contrast hues on
 * the light `#fafaf9` / `#fdfcfa` card background come first and the pale yellow is
 * last. ORDER MATTERS — colors are assigned by author index, so a reorder reshuffles
 * every author's color.
 *
 * This module is pure data + a pure function: no fs/os/path, no imports, so it is
 * browser-safe (check:purity) even though today only the node layer imports it (the
 * client reads the already-derived map from hydration, so this never enters the
 * client bundle).
 */

export const TEAM_PALETTE = [
  "#0072B2", // blue
  "#D55E00", // vermillion
  "#009E73", // bluish green
  "#CC79A7", // reddish purple
  "#E69F00", // orange
  "#56B4E9", // sky blue
  "#F0E442", // yellow (lowest contrast — last)
];

/** Neutral tint for reader asks (not team members) — matches warren's convention. */
export const READER_COLOR = "#78716c";

/**
 * Assign a stable color to each distinct author slug.
 *
 * DETERMINISTIC ORDERING: the distinct slugs are sorted lexicographically, then
 * assigned in that order. This is order-independent of node/tree traversal, so the
 * same hole always yields the same author→color map regardless of how the nodes
 * happen to be iterated. Any slug beginning with `reader` is a reader ask (warren's
 * convention) and takes READER_COLOR without consuming a palette slot; the remaining
 * (team-member) slugs take TEAM_PALETTE by their index among non-reader slugs,
 * cycling with `% TEAM_PALETTE.length` when there are more authors than colors.
 *
 * Pure + deterministic.
 */
export function assignAuthorColors(slugs) {
  const distinct = [...new Set(slugs)].sort();
  const colors = {};
  let paletteIndex = 0;
  for (const slug of distinct) {
    if (slug.startsWith("reader")) {
      colors[slug] = READER_COLOR;
      continue;
    }
    colors[slug] = TEAM_PALETTE[paletteIndex % TEAM_PALETTE.length];
    paletteIndex += 1;
  }
  return colors;
}

/**
 * Build the author half of the page hydration from the hole's nodes.
 *
 * Returns `{ authors, authorColors }` where `authors` maps node_id → author slug and
 * `authorColors` maps author slug → hex, OR `null` when NO node carries an
 * `origin.author`. Returning null lets the caller omit the author keys entirely, so a
 * personal hole's hydration (and rendered page) is byte-for-byte unchanged — no
 * author means no chip and no tint.
 *
 * `nodeList` is any iterable of nodes with `{ id, origin }`.
 */
export function deriveAuthorHydration(nodeList) {
  const authors = {};
  const slugs = [];
  for (const node of nodeList) {
    const raw = node && node.origin && typeof node.origin.author === "string" ? node.origin.author.trim() : "";
    if (!raw) continue;
    authors[node.id] = raw;
    slugs.push(raw);
  }
  if (!slugs.length) return null;
  return { authors, authorColors: assignAuthorColors(slugs) };
}

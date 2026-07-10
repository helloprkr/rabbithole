import { BRANCH_DEFINITION, BRANCH_FOLLOWUP, BRANCH_NOTE, BRANCH_SELECTION, branchTypeOfNode } from "./model.js";

// Page-size defaults (≈US Letter at 96dpi): most source documents are pages,
// so cards open as pages — not chat bubbles. Gaps sized so page-tall siblings
// read as a spine with air between them, not a shingled stack.
export const DEFAULT_ROOT = Object.freeze({ w: 880, h: 1120 });
export const DEFAULT_CHILD = Object.freeze({ w: 820, h: 1060 });
// Notes and definitions are margin voices, not pages — sized like what they are.
export const DEFAULT_NOTE = Object.freeze({ w: 560, h: 420 });
export const DEFAULT_DEFINITION = Object.freeze({ w: 420, h: 300 });

// The size a node gets when its record carries none, keyed by what the node IS
// (origin.branch_type) — a size-less note or definition arriving from the team
// must never render as a full document page.
export function defaultNodeSize(node, isRoot = false) {
  if (isRoot) return DEFAULT_ROOT;
  const type = branchTypeOfNode(node);
  if (type === BRANCH_NOTE) return DEFAULT_NOTE;
  if (type === BRANCH_DEFINITION) return DEFAULT_DEFINITION;
  return DEFAULT_CHILD;
}
export const TREE_PARENT_GAP = 90;
export const TREE_STACK_GAP = 60;

export function nodeOrder(a, b) {
  return ((a?._order || 0) - (b?._order || 0)) || String(a?.id || "").localeCompare(String(b?.id || ""));
}

export function nodeX(node) {
  return Number(node?.x ?? node?.position?.x) || 0;
}

export function nodeY(node) {
  return Number(node?.y ?? node?.position?.y) || 0;
}

export function nodeW(node, fallback = DEFAULT_CHILD.w) {
  return Number(node?.w ?? node?.size?.w) || fallback;
}

export function nodeH(node, fallback = DEFAULT_CHILD.h) {
  return Number(node?.h ?? node?.size?.h) || fallback;
}

export function nodeBounds(node, { effH = null } = {}) {
  const x = nodeX(node);
  const y = nodeY(node);
  const w = nodeW(node);
  const h = typeof effH === "function" ? effH(node) : nodeH(node);
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

export function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

export function shiftBounds(bounds, dx, dy) {
  return {
    minX: bounds.minX + dx,
    minY: bounds.minY + dy,
    maxX: bounds.maxX + dx,
    maxY: bounds.maxY + dy,
  };
}

export function boundsOverlap(a, b) {
  return !!(a && b && a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY);
}

export function subtreeBounds(node, { childrenOf, effH = null, sort = nodeOrder } = {}) {
  let bounds = nodeBounds(node, { effH });
  if (!node?.collapsed && typeof childrenOf === "function") {
    for (const child of childrenOf(node.id).sort(sort)) {
      bounds = unionBounds(bounds, subtreeBounds(child, { childrenOf, effH, sort }));
    }
  }
  return bounds;
}

export function placeChild(parent, branchType, { childrenOf, effH = null, sort = nodeOrder, childSize = DEFAULT_CHILD } = {}) {
  const type = branchType === BRANCH_SELECTION ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
  const parentX = nodeX(parent);
  const parentY = nodeY(parent);
  const parentW = nodeW(parent);
  const x = type === BRANCH_SELECTION ? parentX + parentW + TREE_PARENT_GAP : parentX;
  let y = type === BRANCH_SELECTION ? parentY : parentY + (typeof effH === "function" ? effH(parent) : nodeH(parent)) + TREE_PARENT_GAP;
  const siblings = typeof childrenOf === "function" ? childrenOf(parent.id).sort(sort) : [];
  for (const sibling of siblings) {
    if (branchTypeOfNode(sibling) === type) {
      y = Math.max(y, subtreeBounds(sibling, { childrenOf, effH, sort }).maxY + TREE_STACK_GAP);
    }
  }
  const blockers = siblings
    .filter((sibling) => branchTypeOfNode(sibling) !== type)
    .map((sibling) => subtreeBounds(sibling, { childrenOf, effH, sort }))
    .sort((a, b) => (a.minY - b.minY) || (a.minX - b.minX));
  let candidate = { minX: x, minY: y, maxX: x + childSize.w, maxY: y + childSize.h };
  let bumped = true;
  let guard = 0;
  while (bumped && guard++ < 100) {
    bumped = false;
    for (const blocker of blockers) {
      if (boundsOverlap(candidate, blocker)) {
        y = blocker.maxY + TREE_STACK_GAP;
        candidate = { minX: x, minY: y, maxX: x + childSize.w, maxY: y + childSize.h };
        bumped = true;
      }
    }
  }
  return { x, y };
}

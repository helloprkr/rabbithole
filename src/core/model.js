import { inheritedNodeBaseUrl } from "./base-url.js";

export const BRANCH_SELECTION = "selection";
export const BRANCH_FOLLOWUP = "followup";
// Beyond ask-branches: attached documents, human-written notes, and per-member
// definition lookups (⌘+select). All ride origin.branch_type — the node schema
// itself is unchanged, so old holes and the hub round-trip them untouched.
export const BRANCH_DOCUMENT = "document";
export const BRANCH_NOTE = "note";
export const BRANCH_DEFINITION = "definition";
const BRANCH_TYPES = new Set([BRANCH_SELECTION, BRANCH_FOLLOWUP, BRANCH_DOCUMENT, BRANCH_NOTE, BRANCH_DEFINITION]);

// The built-in four lenses — the fail-soft default whenever no config lens pack
// is installed. Kept as an ordered list so both the button order and the
// number-key shortcuts derive from it.
export const BUILTIN_LENSES = [
  {
    id: "explain",
    label: "Explain",
    q: "Explain this clearly and precisely: what it means here, why it matters, and the key intuition an expert would want me to take away.",
  },
  {
    id: "eli5",
    label: "ELI5",
    q: "Explain this like I'm five: start with a concrete everyday analogy, then translate the analogy back to the real thing, one level more precise.",
  },
  {
    id: "example",
    label: "Example",
    q: "Show this in action with one concrete worked example: realistic, minimal, step by step. Use runnable code if it's code-shaped, real numbers if it's quantitative.",
  },
  {
    id: "deeper",
    label: "Go Deeper",
    q: "Go one level deeper than this document does: the underlying mechanism, the important edge cases, and what experts know about this that introductory treatments gloss over.",
  },
];

// Config-driven lenses (Warren patch 1, re-ported to the centralized model seam).
// LENSES / LENS_ORDER are the single source of truth consumed by the reducer, the
// answering prompt, and every UI surface. They are mutated IN PLACE by
// configureLenses so imported bindings stay live: the node server installs the
// lenses loaded from ~/.rabbithole/config.json before it reduces a branch request
// (src/node/lenses.js), and the browser installs hydration.lenses at initCore.
// Absent that call, the built-in four stand.
export const LENSES = {};
export const LENS_ORDER = [];

const LENS_ID_RE = /^[A-Za-z0-9_-]+$/;

function installLenses(list) {
  for (const key of Object.keys(LENSES)) delete LENSES[key];
  LENS_ORDER.length = 0;
  const seen = new Set();
  for (const lens of list) {
    if (!lens || typeof lens.id !== "string" || seen.has(lens.id)) continue;
    seen.add(lens.id);
    LENSES[lens.id] = { label: lens.label || lens.id, q: lens.q || "" };
    LENS_ORDER.push(lens.id);
  }
}

installLenses(BUILTIN_LENSES);

/**
 * Install a lens set (config- or hydration-driven). A missing, empty, or fully
 * invalid list keeps the built-in four — this fail-soft default is what lets the
 * whole feature be dead code without a config lens pack. Ids must be a safe slug
 * (they become origin.lens and DOM data attributes); the first definition of an
 * id wins.
 */
export function configureLenses(list) {
  if (!Array.isArray(list) || list.length === 0) {
    installLenses(BUILTIN_LENSES);
    return;
  }
  const valid = list.filter(
    (lens) =>
      lens &&
      typeof lens.id === "string" &&
      LENS_ID_RE.test(lens.id) &&
      typeof lens.label === "string" &&
      lens.label.length > 0 &&
      typeof lens.q === "string" &&
      lens.q.length > 0
  );
  installLenses(valid.length ? valid : BUILTIN_LENSES);
}

export function truncate(value, length) {
  const s = String(value ?? "");
  return s.length > length ? `${s.slice(0, length).trimEnd()}…` : s;
}

export function lensLabel(key) {
  return LENSES[key] ? LENSES[key].label : String(key || "");
}

export function normalizeLens(lens) {
  const key = String(lens ?? "").trim();
  return Object.prototype.hasOwnProperty.call(LENSES, key) ? key : null;
}

export function normalizeBranchType(type, selectedText = "") {
  const key = String(type ?? "").trim();
  if (BRANCH_TYPES.has(key)) return key;
  return selectedText ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
}

export function branchTypeOfNode(node) {
  if (!node || (!node.origin && !node.parent_id)) return null;
  const type = node.origin?.branch_type;
  if (BRANCH_TYPES.has(type)) return type;
  return node.origin?.selected_text ? BRANCH_SELECTION : BRANCH_FOLLOWUP;
}

// Local-only cards (definitions) live in their maker's browser: they are never
// pushed to the team canvas, never merged, never published. (A pending clew-bound
// stub still transits the hub inbox so the house answerer can fill it — the
// merge and every client's ingest filter on this same flag.)
export function isLocalOnlyNode(node) {
  return node?.origin?.local === true;
}

export function normalizePosition(pos) {
  return {
    x: Number(pos?.x) || 0,
    y: Number(pos?.y) || 0,
  };
}

export function normalizeSize(size) {
  if (!size) return null;
  const w = Number(size.w);
  const h = Number(size.h);
  if (!w || !h) return null;
  return { w, h };
}

export function normalizeAnchor(anchor) {
  if (!anchor) return null;
  const start = Math.max(0, Number(anchor.offset_start) || 0);
  const end = Math.max(start, Number(anchor.offset_end) || start);
  return { offset_start: start, offset_end: end };
}

export function normalizeViewState(state) {
  if (!state || typeof state !== "object") return null;
  const out = {
    mode: state.mode === "canvas" ? "canvas" : "reader",
    node_id: typeof state.node_id === "string" ? state.node_id.slice(0, 128) : null,
    scroll: Math.max(0, Number(state.scroll) || 0),
  };
  if (state.view && typeof state.view === "object") {
    out.view = {
      x: Number(state.view.x) || 0,
      y: Number(state.view.y) || 0,
      scale: Math.min(2.5, Math.max(0.15, Number(state.view.scale) || 1)),
    };
  }
  return out;
}

export function createPendingBranchNode(payload, parent, { now = new Date().toISOString() } = {}) {
  const selectedText = String(payload.selected_text ?? "").trim();
  const question = String(payload.question ?? "").trim();
  const lens = normalizeLens(payload.lens);
  const synthesis = payload.synthesis === true;
  const anchor = normalizeAnchor(payload.anchor);
  const branchType = normalizeBranchType(payload.branch_type, selectedText);
  const inheritedBase = inheritedNodeBaseUrl(parent);
  const nodeId = String(payload.node_id || "");

  const title = synthesis ? "Synthesis"
    : branchType === BRANCH_DEFINITION ? truncate(selectedText || question, 48)
    : lens ? lensLabel(lens)
    : question ? truncate(question, 48) : "…";
  return {
    id: nodeId,
    parent_id: String(payload.parent_id || ""),
    title,
    markdown: "",
    base_url: inheritedBase.base_url,
    base_url_source: inheritedBase.base_url_source,
    origin: {
      selected_text: selectedText, question, lens, synthesis, anchor, branch_type: branchType,
      ...(payload.local === true ? { local: true } : {}),
    },
    position: normalizePosition(payload.position),
    size: normalizeSize(payload.size),
    font_scale: 1,
    collapsed: false,
    status: "pending",
    read: false,
    created_at: now,
  };
}

export function applyNodeUpdateFields(node, payload) {
  const next = { ...node };
  if (payload.position) next.position = normalizePosition(payload.position);
  if (payload.size) next.size = normalizeSize(payload.size);
  if (typeof payload.collapsed === "boolean") next.collapsed = payload.collapsed;
  if (Number.isFinite(payload.font_scale)) next.font_scale = payload.font_scale;
  if (typeof payload.read === "boolean") next.read = payload.read;
  return next;
}

export function childrenOfNode(nodes, parentId) {
  const out = [];
  for (const node of valuesOfNodes(nodes)) {
    if (node.parent_id === parentId) out.push(node);
  }
  return out;
}

export function collectSubtreeIds(nodes, rootId) {
  const doomed = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of valuesOfNodes(nodes)) {
      if (node.parent_id && doomed.has(node.parent_id) && !doomed.has(node.id)) {
        doomed.add(node.id);
        grew = true;
      }
    }
  }
  return [...doomed];
}

export function lineageNodesFromMap(nodes, nodeId) {
  const path = [];
  let current = getNode(nodes, nodeId);
  const guard = new Set();
  while (current && !guard.has(current.id)) {
    guard.add(current.id);
    path.push(current);
    current = current.parent_id ? getNode(nodes, current.parent_id) : null;
  }
  return path.reverse();
}

export function lineageTitlesFromMap(nodes, nodeId) {
  return lineageNodesFromMap(nodes, nodeId).map((node) => node.title || "Untitled");
}

export function getNode(nodes, id) {
  return nodes instanceof Map ? nodes.get(id) : nodes?.[id];
}

export function valuesOfNodes(nodes) {
  return nodes instanceof Map ? nodes.values() : Object.values(nodes || {});
}

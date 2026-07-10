import { createHoleState, holeStateToHole, reduceHoleEvent } from "../../core/reducer.js";
import { lineageNodesFromMap, truncate } from "../../core/model.js";
import { extractAssetRefsFromMarkdown } from "../../core/assets.js";
import { deriveAuthorHydration } from "../../core/team-palette.js";
import { TitleSentinelParser, fallbackTitleForNode, normalizeProviderError } from "../brain/index.js";

const SAVE_DEBOUNCE_MS = 400;

export class DirectRabbitholeHost {
  constructor({ store, hole, brain = null, author = "", clewBacked = false, onEvent = null, onToast = null, onDone = null, onRestore = null, onNeedsKey = null, onClewAsk = null, onDeleted = null } = {}) {
    this.store = store;
    this.brain = brain;
    // Team workspace sign-in: stamped as origin.author on every node created
    // here so cards carry their maker's name from the moment they exist.
    this.author = typeof author === "string" ? author : "";
    // Clew-backed member (workspace.json clewAuthors): key-less asks are handed
    // to the team's house answerer instead of failing with a provider error.
    this.clewBacked = !!clewBacked;
    this.onEvent = onEvent;
    this.onToast = onToast;
    this.onDone = onDone;
    this.onRestore = onRestore;
    this.onNeedsKey = onNeedsKey;
    this.onClewAsk = onClewAsk;
    this.onDeleted = onDeleted;
    this.state = createHoleState(hole);
    this.holeId = this.state.hole_id;
    this.title = this.state.title;
    this.saveTimer = 0;
    this.savingChain = Promise.resolve();
    this.abortByNode = new Map();
    this.lastEventId = 0;
  }

  hydration() {
    // Author chips (Warren patch 3) ride hydration exactly like the node
    // server's buildHydration: maps derived from each node's origin.author,
    // omitted entirely when no node carries one (personal holes unchanged).
    const authorHydration = deriveAuthorHydration(this.state.nodes.values());
    return {
      session_id: `web-${this.holeId}`,
      hole_id: this.holeId,
      title: this.title,
      root_id: this.state.root_id,
      last_event_id: this.lastEventId,
      agent_attached: true,
      view_state: this.state.view_state,
      nodes: this.serializeNodes(),
      ...(authorHydration || {}),
      ...(this.author ? { self_author: this.author } : {}),
    };
  }

  adapter() {
    return {
      connect: ({ onOpen, onMessage }) => {
        this.onEvent = (event) => {
          onMessage?.(event);
        };
        setTimeout(() => onOpen?.(), 0);
        return { close: () => {} };
      },
      post: (payload) => this.handleBrowserEvent(payload),
    };
  }

  serializeNodes() {
    return [...this.state.nodes.values()].map((n) => ({
      id: n.id,
      parent_id: n.parent_id ?? null,
      title: n.title ?? "",
      markdown: n.markdown ?? "",
      base_url: n.base_url ?? null,
      base_url_source: n.base_url_source ?? null,
      origin: n.origin ?? null,
      position: n.position ?? { x: 0, y: 0 },
      size: n.size ?? null,
      font_scale: n.font_scale ?? 1,
      collapsed: !!n.collapsed,
      status: n.status ?? "answered",
      read: !!n.read,
    }));
  }

  async handleBrowserEvent(payload) {
    const type = String(payload?.type ?? "");
    try {
      switch (type) {
        case "branch_request":
          return await this.handleBranchRequest(payload);
        case "retry_branch":
          return this.handleRetry(payload);
        case "node_update":
          this.dispatch({ ...payload, type: "node_update" });
          this.scheduleSave();
          return { ok: true };
        case "nodes_update":
          this.dispatch({ ...payload, type: "nodes_update" });
          this.scheduleSave();
          return { ok: true };
        case "delete_node":
          return await this.handleDeleteNode(payload);
        case "view_state":
          this.dispatch({ ...payload, type: "view_state" });
          this.scheduleSave();
          return { ok: true };
        case "done":
          await this.flushSave();
          this.onDone?.();
          return { ok: true };
        default:
          throw new Error(`Unsupported browser event: ${type}`);
      }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  }

  async handleBranchRequest(payload) {
    const result = this.dispatch({ ...payload, type: "branch_request" }, { now: new Date().toISOString() });
    const node = result.createdNode;
    // Stamp the signed-in member as the node's author (never restamp another's).
    if (this.author) {
      const created = this.state.nodes.get(node.id);
      if (created?.origin && !created.origin.author) {
        created.origin = { ...created.origin, author: this.author };
      }
    }
    await this.flushSave();
    this.startAnswer(node.id, { reset: false });
    return { ok: true, node_id: node.id, request_id: payload.request_id };
  }

  handleRetry(payload) {
    const node = this.state.nodes.get(String(payload.node_id || ""));
    if (!node || node.status !== "pending") return { ok: true };
    this.startAnswer(node.id, { reset: true });
    return { ok: true };
  }

  async handleDeleteNode(payload) {
    const targetId = String(payload.node_id || "");
    if (!targetId || targetId === this.state.root_id) return { ok: false, error: "Cannot delete the root document" };
    if (!this.state.nodes.has(targetId)) return { ok: true, deleted: [] };

    const reduced = reduceHoleEvent(this.state, { type: "delete_node", node_id: targetId });
    const deletedNodes = (reduced.effects?.deletedNodes || []).map((node) => ({ ...node }));
    const deletedIds = deletedNodes.map((node) => node.id);
    const parentId = deletedNodes[0]?.parent_id || null;
    const deletedAssets = await this.snapshotAssetsForDeletedNodes(deletedNodes);
    for (const id of deletedIds) {
      const controller = this.abortByNode.get(id);
      if (controller) controller.abort();
      this.abortByNode.delete(id);
    }
    this.state = reduced.state;
    await this.gcAssetsForDeletedNodes(deletedNodes);
    this.scheduleSave();
    this.emit({ type: "node_deleted", node_ids: deletedIds });
    // Team plumbing (the /app workspace wires this): record tombstones so the
    // delete STICKS — without them the periodic pull re-materializes anything
    // still in the merged team hole, forever.
    this.onDeleted?.({ nodes: deletedNodes.map((n) => ({ id: n.id, origin: n.origin ?? null })) });

    const title = deletedNodes[0]?.title || "Untitled";
    this.onToast?.({
      message: deletedIds.length > 1
        ? `Removed "${truncate(title, 40)}" and ${deletedIds.length - 1} inside it`
        : `Removed "${truncate(title, 40)}"`,
      actionLabel: "Undo",
      timeoutMs: 10000,
      onAction: async () => {
        await this.restoreDeletedNodes(deletedNodes, deletedAssets);
        this.onRestore?.({ parentId, nodes: deletedNodes.map((n) => ({ id: n.id, origin: n.origin ?? null })) });
      },
    });
    return { ok: true, deleted: deletedIds };
  }

  async restoreDeletedNodes(deletedNodes, deletedAssets = []) {
    const nodes = new Map(this.state.nodes);
    for (const node of deletedNodes) nodes.set(node.id, { ...node });
    this.state = { ...this.state, nodes };
    for (const asset of deletedAssets) {
      if (asset.blob) await this.store.putAsset(this.holeId, asset.name, asset.blob);
    }
    await this.flushSave();
  }

  async snapshotAssetsForDeletedNodes(deletedNodes) {
    const refs = new Set();
    for (const node of deletedNodes) {
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) refs.add(name);
    }
    const out = [];
    for (const name of refs) {
      try {
        const blob = await this.store.getAsset(this.holeId, name);
        if (blob) out.push({ name, blob });
      } catch {}
    }
    return out;
  }

  async gcAssetsForDeletedNodes(deletedNodes) {
    const deletedRefs = new Set();
    for (const node of deletedNodes) {
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) deletedRefs.add(name);
    }
    if (!deletedRefs.size) return;
    const remainingRefs = new Set();
    for (const node of this.state.nodes.values()) {
      for (const name of extractAssetRefsFromMarkdown(node.markdown)) remainingRefs.add(name);
    }
    for (const name of deletedRefs) {
      if (remainingRefs.has(name)) continue;
      try { await this.store.deleteAsset(this.holeId, name); } catch {}
    }
  }

  dispatch(event, options) {
    const reduced = reduceHoleEvent(this.state, event, options);
    this.state = reduced.state;
    return reduced.effects || {};
  }

  startAnswer(nodeId, { reset = false } = {}) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;

    const controller = new AbortController();
    const previous = this.abortByNode.get(nodeId);
    if (previous) previous.abort();
    this.abortByNode.set(nodeId, controller);

    if (reset) {
      this.dispatchProgress(nodeId, "", { emit: true });
    }

    queueMicrotask(() => this.runAnswer(nodeId, controller).catch((err) => {
      this.handleAnswerError(nodeId, err, controller.signal);
    }));
  }

  async runAnswer(nodeId, controller) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    if (!this.brain) {
      if (this.clewBacked) {
        // No key, but the house answerer covers this member: hand the ask to
        // Clew. Stamp the stub so the answerer skips its grace window (nothing
        // here will ever answer first), release the card (a held controller
        // blocks ingestRemoteNodes' update-in-place), and trigger an immediate
        // sync so the stub reaches the hub now, not at the next 20s tick. The
        // card keeps its "Clewing" state until the answer lands over SSE.
        node.origin = { ...(node.origin ?? {}), answer_via: "clew" };
        this.abortByNode.delete(nodeId);
        await this.flushSave();
        this.onClewAsk?.(nodeId);
        return;
      }
      // Session-only keys live in page memory and vanish when the browser
      // silently reloads a long-idle tab — surface that instead of failing quietly.
      this.onNeedsKey?.();
      throw new Error("Add a provider key in Settings before asking.");
    }

    const context = this.buildBranchContext(node);
    const parser = new TitleSentinelParser({ fallbackTitle: fallbackTitleForNode(node) });
    let markdown = resetMarkdownForRun(node);

    for await (const chunk of this.brain.answerBranch(context, controller.signal)) {
      if (controller.signal.aborted || !this.isLivePending(nodeId)) return;
      const delta = parser.push(chunk);
      if (!delta) continue;
      markdown += delta;
      this.dispatchProgress(nodeId, markdown, { emit: true });
    }

    const tail = parser.finish();
    if (tail) {
      markdown += tail;
      this.dispatchProgress(nodeId, markdown, { emit: true });
    }
    if (controller.signal.aborted || !this.isLivePending(nodeId)) return;

    const current = this.state.nodes.get(nodeId);
    const title = parser.title || fallbackTitleForNode(current);
    this.dispatch({
      type: "node_answered",
      node_id: current.id,
      parent_id: current.parent_id,
      title,
      markdown,
      base_url: current.base_url,
      base_url_source: current.base_url_source,
      origin: current.origin,
      position: current.position,
      size: current.size,
      font_scale: current.font_scale,
      read: false,
    });
    const finalNode = this.state.nodes.get(nodeId);
    this.abortByNode.delete(nodeId);
    this.emit({
      type: "node_answered",
      node_id: finalNode.id,
      parent_id: finalNode.parent_id,
      title: finalNode.title,
      markdown: finalNode.markdown,
      base_url: finalNode.base_url,
      base_url_source: finalNode.base_url_source,
      origin: finalNode.origin,
      position: finalNode.position,
      size: finalNode.size,
      font_scale: finalNode.font_scale,
    });
    await this.flushSave();
  }

  handleAnswerError(nodeId, err, signal) {
    this.abortByNode.delete(nodeId);
    if (signal?.aborted && !this.state.nodes.has(nodeId)) return;
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    const normalized = normalizeProviderError(err);
    this.emit({
      type: "node_error",
      node_id: nodeId,
      message: normalized.message,
      code: normalized.code,
      retryable: normalized.retryable,
      markdown: node.markdown || "",
    });
    this.scheduleSave();
  }

  dispatchProgress(nodeId, markdown, { emit = false } = {}) {
    const node = this.state.nodes.get(nodeId);
    if (!node || node.status !== "pending") return;
    this.dispatch({
      type: "node_progress",
      node_id: nodeId,
      markdown,
      base_url: node.base_url,
      base_url_source: node.base_url_source,
    });
    const current = this.state.nodes.get(nodeId);
    if (emit) {
      this.emit({
        type: "node_progress",
        node_id: nodeId,
        markdown: current.markdown,
        base_url: current.base_url,
        base_url_source: current.base_url_source,
      });
    }
    this.scheduleSave();
  }

  buildBranchContext(node) {
    const parent = this.state.nodes.get(node.parent_id);
    const root = this.state.nodes.get(this.state.root_id);
    const lineage = parent ? lineageNodesFromMap(this.state.nodes, parent.id) : [];
    const ancestors = lineage.filter((entry) => entry.id !== parent?.id).map((entry) => ({
      title: entry.title,
      markdown: entry.markdown,
    }));
    return {
      root_title: root?.title || this.state.title || "Untitled",
      parent_title: parent?.title || "Untitled",
      parent_markdown: parent?.markdown || "",
      ancestors,
      selected_text: node.origin?.selected_text || "",
      question: node.origin?.question || "",
      lens: node.origin?.lens || null,
      synthesis: !!node.origin?.synthesis,
    };
  }

  isLivePending(nodeId) {
    const node = this.state.nodes.get(nodeId);
    return !!node && node.status === "pending";
  }

  // Merge nodes fetched from a remote copy of this hole (the team hub) into the
  // live session. Ids we don't hold are ingested as new cards; an id we hold as
  // a PENDING stub whose remote copy carries content is updated in place — that
  // is an ask answered elsewhere (a teammate's claim, the team agent) landing on
  // the very card that was waiting for it. Local work is never clobbered: a
  // node that is answered locally, or actively streaming here, is left alone.
  // Each ingested/updated node is dispatched AND emitted as node_answered: the
  // client self-heals unknown ids into new cards ("Since you left") and
  // re-renders known ids in place. Parents are ingested before children; nodes
  // whose parent never materializes are skipped.
  ingestRemoteNodes(remoteNodes = []) {
    const incoming = (Array.isArray(remoteNodes) ? remoteNodes : []).filter(
      (n) => n && typeof n.id === "string" && n.id
    );
    const queue = incoming.filter((n) => !this.state.nodes.has(n.id));
    const added = [];

    // Update-in-place: remote answer for a locally-pending stub.
    for (const n of incoming) {
      const local = this.state.nodes.get(n.id);
      if (!local || local.status !== "pending") continue;
      if (this.abortByNode.has(n.id)) continue; // a live local stream owns this card
      const remoteMd = typeof n.markdown === "string" ? n.markdown.trim() : "";
      if (!remoteMd || remoteMd === (local.markdown ?? "").trim()) continue;
      const event = {
        type: "node_answered",
        node_id: n.id,
        parent_id: local.parent_id ?? null,
        title: typeof n.title === "string" && n.title ? n.title : local.title || "",
        markdown: n.markdown,
        base_url: n.base_url ?? local.base_url ?? null,
        base_url_source: n.base_url_source ?? local.base_url_source ?? null,
        origin: n.origin && typeof n.origin === "object" ? n.origin : local.origin ?? null,
        position: local.position ?? { x: 0, y: 0 }, // keep the card where the asker put it
        size: local.size ?? null,
        font_scale: local.font_scale ?? 1,
        read: false,
      };
      this.dispatch(event);
      this.emit(event);
      added.push(n.id);
    }

    let progressed = true;
    while (queue.length && progressed) {
      progressed = false;
      for (let i = 0; i < queue.length; i++) {
        const n = queue[i];
        const parentId = n.parent_id ?? null;
        if (parentId && !this.state.nodes.has(parentId)) continue;
        queue.splice(i, 1);
        i -= 1;
        progressed = true;
        const event = {
          type: "node_answered",
          node_id: n.id,
          parent_id: parentId,
          title: typeof n.title === "string" ? n.title : "",
          markdown: typeof n.markdown === "string" ? n.markdown : "",
          base_url: n.base_url ?? null,
          base_url_source: n.base_url_source ?? null,
          origin: n.origin && typeof n.origin === "object" ? n.origin : null,
          position: n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y)
            ? { x: n.position.x, y: n.position.y }
            : { x: 0, y: 0 },
          size: n.size ?? null,
          font_scale: n.font_scale ?? 1,
          created_at: typeof n.created_at === "string" ? n.created_at : null,
          read: false,
        };
        this.dispatch(event);
        this.emit(event);
        added.push(n.id);
      }
    }
    if (added.length) this.scheduleSave();
    return added;
  }

  // A teammate deleted their card (a tombstone arrived over sync): mirror the
  // removal silently — no toast, no undo, no re-tombstone (onDeleted not fired).
  removeRemoteDeleted(nodeIds = []) {
    const doomed = nodeIds.filter((id) => typeof id === "string" && id && id !== this.state.root_id && this.state.nodes.has(id));
    if (!doomed.length) return [];
    const reduced = reduceHoleEvent(this.state, { type: "node_deleted", node_ids: doomed });
    this.state = reduced.state;
    for (const id of doomed) {
      const controller = this.abortByNode.get(id);
      if (controller) controller.abort();
      this.abortByNode.delete(id);
    }
    this.scheduleSave();
    this.emit({ type: "node_deleted", node_ids: doomed });
    return doomed;
  }

  emit(event) {
    this.lastEventId += 1;
    this.onEvent?.(event);
  }

  scheduleSave() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), SAVE_DEBOUNCE_MS);
  }

  async flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
    }
    const snapshot = holeStateToHole(this.state);
    this.savingChain = this.savingChain
      .catch(() => {})
      .then(() => this.store.saveHole(snapshot));
    return this.savingChain;
  }
}

export function createHoleFromMarkdown({ title, markdown, baseUrl = null } = {}) {
  const now = new Date().toISOString();
  const holeId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `hole-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const rootId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `root-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const inferredTitle = title || titleFromMarkdown(markdown) || "Untitled";
  return {
    hole_id: holeId,
    title: inferredTitle,
    root_id: rootId,
    created_at: now,
    view_state: null,
    nodes: [{
      id: rootId,
      parent_id: null,
      title: inferredTitle,
      markdown: String(markdown || ""),
      base_url: baseUrl,
      base_url_source: baseUrl ? "explicit" : null,
      origin: null,
      position: { x: 0, y: 0 },
      size: null,
      font_scale: 1,
      collapsed: false,
      status: "answered",
      read: true,
      created_at: now,
    }],
  };
}

function titleFromMarkdown(markdown) {
  const match = /^#\s+(.+)$/m.exec(String(markdown || ""));
  return match ? truncate(match[1].trim(), 80) : "";
}

function resetMarkdownForRun(node) {
  return node?.markdown && node.status === "pending" ? String(node.markdown) : "";
}

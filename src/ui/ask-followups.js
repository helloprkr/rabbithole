import {
  BRANCH_DEFINITION,
  BRANCH_FOLLOWUP,
  BRANCH_NOTE,
  BRANCH_SELECTION,
  DEFAULT_CHILD,
  LENSES,
  ask,
  askGo,
  askText,
  canvasBuilt,
  childrenOf,
  closed,
  composerInner,
  composerSend,
  composerText,
  connLost,
  currentNodeId,
  easeOutMotion,
  esc,
  selfAuthor,
  flashHint,
  frozen,
  agentAttached,
  LENS_ORDER,
  lensLabel,
  mode,
  motionSourceFromEvent,
  nextOrder,
  nodeOrder,
  nodes,
  readerMain,
  refreshAmbient,
  setSurfaceOrigin,
  shouldReduceMotion,
  truncate,
  uuid
} from "./core.js";
import {
  placeChild as sharedPlaceChild,
  subtreeBounds as sharedSubtreeBounds
} from "../core/layout.js";
import {
  autoGrowEl,
  createNodeEl,
  drawEdges,
  effH,
  revealNode,
  renderVisibility,
  scheduleEdges
} from "./canvas-view.js";
import {
  buildThreadItem,
  charOffset,
  ensureThread,
  removeMarks,
  removeThreadItem,
  renderSidebar,
  wrapInContainer
} from "./reader.js";
import { refreshNodeHtml } from "./renderer.js";

var askHooks = {
  post: function(){ return Promise.resolve({ ok: true }); },
  closeShare: function(){},
  hideConfirm: function(){},
  hidePeek: function(){},
  // Optional: attach a document (pdf/md) as a branch of the current selection.
  // Only the /app web workspace wires this; absent → the button never shows.
  attach: null,
  // Optional: place a human-written note node (no AI). Receives the fully-built
  // node; the /app workspace persists + syncs it. Absent → the button never shows.
  note: null
};

export function registerAskHooks(hooks) {
  Object.assign(askHooks, hooks || {});
  var row = document.getElementById("ask-attach-row");
  var hasAttach = typeof askHooks.attach === "function";
  var hasNote = typeof askHooks.note === "function";
  if (row) row.classList.toggle("available", hasAttach || hasNote);
  var attachBtn = document.getElementById("ask-attach");
  if (attachBtn) attachBtn.style.display = hasAttach ? "" : "none";
  var noteBtn = document.getElementById("ask-note");
  if (noteBtn) noteBtn.style.display = hasNote ? "" : "none";
}

  // ===========================================================================
  // ASK (shared by both views)
  // ===========================================================================
export function initAskFollowups(){
  document.addEventListener("mousedown", function(e){
    var c = e.target && e.target.closest ? function(sel){ return e.target.closest(sel); } : function(){ return null; };
    if (!c("#sharemenu") && !c("#r-share") && !c("#t-share")) askHooks.closeShare();
    if (!c("#confirm")) askHooks.hideConfirm();
    if (!c("#peek") && !c("mark[data-child]")) askHooks.hidePeek();
    if (inAsk(e)) return;
    hideAsk();
  });
  document.addEventListener("mouseup", function(e){
    if (inAsk(e)) return;
    // ⌘ held through the selection = "define this": the node pops out directly,
    // no popup. Read the modifier now — it's gone by the time the timeout runs.
    var defineIntent = !!e.metaKey;
    setTimeout(function(){ maybeShowAsk(defineIntent); }, 0);
  });
  askGo.addEventListener("click", function(e){ submitAsk(null, motionSourceFromEvent(e)); });
  // The lens buttons are config-driven (Warren patch 1): shell.js ships an empty
  // #ask-lenses; fill it from the shared LENS_ORDER (built-in four unless a config
  // lens pack overrode them in initCore). Number-key hints show for the first nine.
  renderLensButtons();
  document.getElementById("ask-lenses").addEventListener("click", function(e){
    var b = e.target.closest ? e.target.closest(".lens") : null;
    if (b) submitAsk(b.getAttribute("data-lens"), motionSourceFromEvent(e));
  });
  var attachBtn = document.getElementById("ask-attach");
  if (attachBtn) attachBtn.addEventListener("click", function(e){
    e.preventDefault();
    if (!pendingAsk || typeof askHooks.attach !== "function") return;
    var req = { parentId: pendingAsk.parentId, selectedText: pendingAsk.selectedText,
                anchor: { offset_start: pendingAsk.startOff, offset_end: pendingAsk.endOff } };
    hideAsk();
    askHooks.attach(req);
  });
  var noteBtn = document.getElementById("ask-note");
  if (noteBtn) noteBtn.addEventListener("click", function(e){
    e.preventDefault();
    setAskMode(askMode === "note" ? "ask" : "note");
  });
  askText.addEventListener("input", function(){ autoGrowEl(askText, 110); });
  askText.addEventListener("keydown", onAskTextKeydown);
  composerText.addEventListener("input", function(){ autoGrowComposer(); updateComposerState(); });
  composerText.addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submitFollowup("keyboard"); }
  });
  composerSend.addEventListener("click", function(e){ submitFollowup(motionSourceFromEvent(e)); });
  readerMain.addEventListener("wheel", interruptScrollAnimation, { passive: true });
  readerMain.addEventListener("touchstart", interruptScrollAnimation, { passive: true });
  readerMain.addEventListener("pointerdown", interruptScrollAnimation, { passive: true });
  readerMain.addEventListener("scroll", function(){ if (performance.now() > scrollAnimIgnoreUntil) cancelScrollAnimation(); }, { passive: true });
  document.addEventListener("keydown", interruptScrollAnimation);
}

function inAsk(e){ return e.target && e.target.closest && e.target.closest("#ask"); }

  // Render the ask-popup lens buttons from the config-driven LENS_ORDER. Called
  // once at init (after initCore has installed the active lens set).
  function renderLensButtons(){
    var box = document.getElementById("ask-lenses");
    if (!box) return;
    var html = "";
    for (var i = 0; i < LENS_ORDER.length; i++){
      var id = LENS_ORDER[i];
      var kbd = i < 9 ? ' <kbd>' + (i + 1) + '</kbd>' : '';
      html += '<button class="lens" data-lens="' + esc(id) + '">' + esc(lensLabel(id)) + kbd + '</button>';
    }
    box.innerHTML = html;
  }

  function maybeShowAsk(defineIntent){
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return;
    var anchor = sel.anchorNode && sel.anchorNode.nodeType === 3 ? sel.anchorNode.parentNode : sel.anchorNode;
    var dc = anchor && anchor.closest ? anchor.closest(".doc-content") : null;
    if (!dc) return;
    var parentId = dc.dataset.nodeId;
    if (!parentId || !nodes[parentId] || nodes[parentId].status === "pending") return;
    // Asks stay open while the agent is merely away (they queue server-side and
    // are answered when it returns) — only a fully closed session can't take them.
    if (closed){
      flashHint(frozen ? "This is a read-only snapshot — asking needs the live Rabbithole."
        : "Session ended — reopen this Rabbithole from your terminal to keep asking.");
      return;
    }
    var range = sel.getRangeAt(0);
    // Both endpoints must live inside this same document — a selection dragged
    // out into the sidebar/another card would otherwise yield offsets past the
    // doc's text (no inline mark, a bad persisted anchor).
    if (!dc.contains(range.startContainer) || !dc.contains(range.endContainer)) return;
    var startOff = charOffset(dc, range.startContainer, range.startOffset);
    var endOff = charOffset(dc, range.endContainer, range.endOffset);
    if (endOff <= startOff) return;
    pendingAsk = { parentId: parentId, container: dc, selectedText: sel.toString().trim(),
                   startOff: startOff, endOff: endOff, range: range.cloneRange() };
    // ⌘+select → a definition card pops straight out, no popup. Local to this
    // member: word lookups never crowd the team canvas.
    if (defineIntent){
      submitDefinition("pointer");
      return;
    }
    paintAskHighlight(pendingAsk.range);
    setAskMode("ask");
    askText.value = "";
    var rect = range.getBoundingClientRect();
    ask.style.left = Math.min(window.innerWidth - 392, Math.max(10, rect.left)) + "px";
    ask.style.top = Math.min(window.innerHeight - 200, rect.bottom + 8) + "px";
    ask.classList.add("visible");
    setSurfaceOrigin(ask, rect);
    // Grow only once visible — scrollHeight reads 0 inside display:none.
    autoGrowEl(askText, 110);
    askText.focus();
  }
  var pendingAsk = null;
  // "ask" (question/lens → AI) or "note" (the human's own words, no AI).
  var askMode = "ask";
  function setAskMode(m){
    askMode = m === "note" ? "note" : "ask";
    ask.classList.toggle("note-mode", askMode === "note");
    var noteBtn = document.getElementById("ask-note");
    if (noteBtn) noteBtn.textContent = askMode === "note" ? "↩ Ask AI instead" : "✎ Write a note instead";
    askText.placeholder = askMode === "note" ? "Your note on this — just you, no AI…" : "Ask about this…";
    askGo.title = askMode === "note" ? "Place note (↵)" : "Ask (↵)";
    if (ask.classList.contains("visible")) askText.focus();
  }
export function hideAsk(){
  ask.classList.remove("visible");
  ask.classList.remove("note-mode");
  askMode = "ask";
  pendingAsk = null;
  clearAskHighlight();
}
  // Custom Highlight API — keeps the selected text visibly marked while the popup
  // has focus. Best-effort: browsers without it just fall back to today's look.
  function paintAskHighlight(range){
    try { if (window.Highlight && window.CSS && CSS.highlights) CSS.highlights.set("rh-ask", new Highlight(range)); } catch(e){}
  }
  function clearAskHighlight(){
    try { if (window.CSS && CSS.highlights) CSS.highlights.delete("rh-ask"); } catch(e){}
  }

  // Number-key shortcut → lens id, derived live from the config-driven LENS_ORDER
  // (keys 1..9). Read at press time so it tracks whatever lens set initCore installed.
  function lensForDigit(key){
    var i = /^[1-9]$/.test(key) ? parseInt(key, 10) : 0;
    return i && i <= LENS_ORDER.length ? LENS_ORDER[i - 1] : null;
  }
  function onAskTextKeydown(e){
    if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); submitAsk(null, "keyboard"); }
    else if (e.key === "Escape"){ hideAsk(); }
    // Number keys are lens shortcuts only while the box is empty — once the
    // human starts typing a question, digits are just digits.
    else if (askMode === "ask" && askText.value === "" && !e.metaKey && !e.ctrlKey && !e.altKey && lensForDigit(e.key)){
      e.preventDefault();
      submitAsk(lensForDigit(e.key), "keyboard");
    }
  }

  function submitAsk(lensKey, source){
    if (askMode === "note" && !lensKey){ submitNote(source); return; }
    if (!pendingAsk || closed) return;
    var parent = nodes[pendingAsk.parentId];
    if (!parent){ hideAsk(); return; }
    var lens = (lensKey && LENSES[lensKey]) ? lensKey : null;
    var question = lens ? LENSES[lens].q : askText.value.trim();
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_SELECTION);
    var anchor = { offset_start: pendingAsk.startOff, offset_end: pendingAsk.endOff };
    var node = {
	      id: childId, parent_id: parent.id,
	      title: lens ? lensLabel(lens) : (question ? truncate(question, 48) : "…"),
	      html: "", md: "",
	      base_url: parent.base_url || null,
	      base_url_source: parent.base_url ? "inherited" : null,
	      read: false,
      origin: { selected_text: pendingAsk.selectedText, question: question, lens: lens, anchor: anchor, branch_type: BRANCH_SELECTION,
                author: selfAuthor || undefined },
      x: pos.x, y: pos.y, w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
      status: "pending", _order: nextOrder(), _startTs: Date.now()
    };
    nodes[childId] = node;
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }

    // Mark inline in whichever views currently render the parent doc. Wrap via
    // offsets (always text-node endpoints) — a live Range can end on an element
    // boundary, which the text-walker can't terminate on.
    if (mode === "reader"){
      var rdc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
      wrapInContainer(rdc, anchor, childId, "hl mark-pending");
      if (currentNodeId === parent.id) renderSidebar();
    }
    if (parent.bodyEl){ wrapInContainer(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "hl mark-pending"); scheduleEdges(); }

    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideAsk();
    askHooks.post({ type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
           selected_text: node.origin.selected_text, question: question, lens: lens, anchor: anchor,
           branch_type: BRANCH_SELECTION,
           position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } })
      .then(function(res){ if (!res || !res.ok) rollbackBranch(node); });
    // On the canvas, the new card must never leave the viewport silently —
    // pan just enough that you see where your question went.
    revealNode(node, source);
    refreshAmbient();
  }

  // ---------- definition cards (⌘+select) ----------
  // A per-member dictionary lookup: smaller card, distinct dress, and LOCAL —
  // origin.local keeps it off the team canvas (sync/merge/ingest all filter it).
  var DEFINITION_SIZE = { w: 420, h: 300 };
  function definitionQuestion(term){
    return 'Define "' + term + '": the sense used in this passage first, then the general meaning; ' +
      'part of speech; a one-line origin only if it illuminates. A compact dictionary card. ' +
      'Start directly with the entry — never restate this request, and no meta-commentary ' +
      'about what context you did or did not have.';
  }
  function submitDefinition(source){
    if (!pendingAsk || closed) return;
    var parent = nodes[pendingAsk.parentId];
    if (!parent){ hideAsk(); return; }
    var term = pendingAsk.selectedText;
    var question = definitionQuestion(truncate(term, 120));
    // The sentence around the selection rides along so whoever answers (the
    // member's brain or the house agent) can give the in-THIS-passage sense
    // even before the parent document reaches the merged hole.
    var context = "";
    try {
      var full = pendingAsk.container.textContent || "";
      context = full.slice(Math.max(0, pendingAsk.startOff - 350), Math.min(full.length, pendingAsk.endOff + 350)).trim();
    } catch(e){}
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_SELECTION, DEFINITION_SIZE);
    var anchor = { offset_start: pendingAsk.startOff, offset_end: pendingAsk.endOff };
    var node = {
      id: childId, parent_id: parent.id,
      title: truncate(term, 48),
      html: "", md: "",
      base_url: parent.base_url || null,
      base_url_source: parent.base_url ? "inherited" : null,
      read: false,
      origin: { selected_text: term, question: question, lens: null, anchor: anchor,
                branch_type: BRANCH_DEFINITION, local: true, author: selfAuthor || undefined,
                context: context || undefined },
      x: pos.x, y: pos.y, w: DEFINITION_SIZE.w, h: DEFINITION_SIZE.h, font_scale: 1, collapsed: false,
      status: "pending", _order: nextOrder(), _startTs: Date.now()
    };
    nodes[childId] = node;
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }
    if (mode === "reader"){
      var rdc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
      wrapInContainer(rdc, anchor, childId, "hl mark-pending");
      if (currentNodeId === parent.id) renderSidebar();
    }
    if (parent.bodyEl){ wrapInContainer(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "hl mark-pending"); scheduleEdges(); }
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideAsk();
    askHooks.post({ type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
           selected_text: term, question: question, lens: null, anchor: anchor,
           branch_type: BRANCH_DEFINITION, local: true, context: context,
           position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } })
      .then(function(res){ if (!res || !res.ok) rollbackBranch(node); });
    revealNode(node, source);
    refreshAmbient();
  }

  // ---------- note cards (human words, no AI) ----------
  var NOTE_SIZE = { w: 560, h: 420 };
  function submitNote(source){
    if (!pendingAsk || closed) return;
    if (typeof askHooks.note !== "function") return;
    var text = askText.value.trim();
    if (!text) return;
    var parent = nodes[pendingAsk.parentId];
    if (!parent){ hideAsk(); return; }
    var childId = uuid();
    var pos = placeChild(parent, BRANCH_SELECTION, NOTE_SIZE);
    var anchor = { offset_start: pendingAsk.startOff, offset_end: pendingAsk.endOff };
    var node = {
      id: childId, parent_id: parent.id,
      title: truncate(text, 48),
      html: "", md: text,
      base_url: parent.base_url || null,
      base_url_source: parent.base_url ? "inherited" : null,
      read: true,
      origin: { selected_text: pendingAsk.selectedText, question: "", lens: null, anchor: anchor,
                branch_type: BRANCH_NOTE, author: selfAuthor || undefined },
      x: pos.x, y: pos.y, w: NOTE_SIZE.w, h: NOTE_SIZE.h, font_scale: 1, collapsed: false,
      status: "answered", _order: nextOrder()
    };
    refreshNodeHtml(node);
    nodes[childId] = node;
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }
    if (mode === "reader"){
      var rdc = readerMain.querySelector('.doc-content[data-node-id="' + parent.id + '"]');
      wrapInContainer(rdc, anchor, childId, "hl mark-ready");
      if (currentNodeId === parent.id) renderSidebar();
    }
    if (parent.bodyEl){ wrapInContainer(parent.bodyEl.querySelector(".doc-content"), anchor, childId, "hl mark-ready"); scheduleEdges(); }
    var sel = window.getSelection(); if (sel) sel.removeAllRanges();
    hideAsk();
    askHooks.note({
      id: node.id, parent_id: node.parent_id, title: node.title, markdown: node.md,
      origin: node.origin, position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h },
      created_at: new Date().toISOString()
    });
    revealNode(node, source);
  }

  // ---------- follow-up composer ----------
export function updateComposerState(){
    var current = nodes[currentNodeId];
    // A missing agent doesn't disable asking — questions queue server-side and
    // are answered when it returns. Only a closed session (server gone) does.
    var down = closed || !current || current.status === "pending";
    composerText.disabled = down;
    composerInner.classList.toggle("disabled", down);
    if (frozen) composerText.placeholder = "Read-only snapshot — open the live Rabbithole to keep asking";
    else if (closed) composerText.placeholder = "Session ended — reopen this Rabbithole from your terminal; saved questions are answered there";
    else if (current && current.status === "pending") composerText.placeholder = "This answer is still being written…";
    else if (connLost || !agentAttached) composerText.placeholder = "The agent is away — questions are saved and answered when it returns…";
    else composerText.placeholder = "Ask a follow-up about this document…";
    composerSend.disabled = down || !composerText.value.trim();
  }
  function autoGrowComposer(){ autoGrowEl(composerText, 140); }

  // Shared follow-up submission: from the reader composer or a card's docked one.
  // The thread turn is only appended when the parent is the document currently
  // open in the reader — otherwise it appears on the next open. A synthesis ask
  // rides the same path but renders as a distinct branch node, not a chat turn.
export function sendFollowup(parent, question, lens, synthesis){
    var requestId = uuid(), childId = uuid();
    var pos = placeChild(parent, BRANCH_FOLLOWUP);
    var node = {
	      id: childId, parent_id: parent.id,
	      title: synthesis ? "Synthesis" : lens ? lensLabel(lens) : truncate(question, 48),
	      html: "", md: "",
	      base_url: parent.base_url || null,
	      base_url_source: parent.base_url ? "inherited" : null,
	      read: false,
      origin: { selected_text: "", question: question, lens: lens, synthesis: !!synthesis, anchor: null, branch_type: BRANCH_FOLLOWUP,
                author: selfAuthor || undefined },
      x: pos.x, y: pos.y, w: DEFAULT_CHILD.w, h: DEFAULT_CHILD.h, font_scale: 1, collapsed: false,
      status: "pending", _order: nextOrder(), _startTs: Date.now()
    };
    nodes[childId] = node;
    if (canvasBuilt){ createNodeEl(node, true); renderVisibility(); drawEdges(); }
    if (currentNodeId === parent.id && mode === "reader"){
      if (synthesis) renderSidebar();
      else {
        var t = ensureThread();
        if (t) t.appendChild(buildThreadItem(node));
      }
    }
    var payload = { type: "branch_request", request_id: requestId, node_id: childId, parent_id: parent.id,
           selected_text: "", question: question, lens: lens, anchor: null,
           branch_type: BRANCH_FOLLOWUP,
           position: { x: node.x, y: node.y }, size: { w: node.w, h: node.h } };
    if (synthesis) payload.synthesis = true;
    askHooks.post(payload).then(function(res){ if (!res || !res.ok) rollbackBranch(node); });
    refreshAmbient();
    return node;
  }

  // scrollTo({behavior:"smooth"}) proved unreliable here, so the one deliberate
  // scroll in the app (submit → your new question) is driven by hand. rAF never
  // fires in a hidden window — jump instantly there instead of never arriving.
  var scrollAnimId = 0, scrollAnimIgnoreUntil = 0;
export function cancelScrollAnimation(){ scrollAnimId++; }
  function setAnimatedScrollTop(el, value){
    scrollAnimIgnoreUntil = performance.now() + 80;
    el.scrollTop = value;
  }
export function animateScroll(el, target, source){
    var myId = ++scrollAnimId;
    if (document.hidden || shouldReduceMotion() || source !== "pointer"){ el.scrollTop = target; return; }
    var s = el.scrollTop, t0 = performance.now(), D = 240;
    function step(t){
      if (myId !== scrollAnimId) return;
      var p = Math.min(1, (t - t0) / D), k = easeOutMotion(p);
      setAnimatedScrollTop(el, s + (target - s) * k);
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }
  function interruptScrollAnimation(){ cancelScrollAnimation(); }
  function submitFollowup(source){
    if (closed){ flashHint(frozen ? "This is a read-only snapshot." : "Session ended — reopen this Rabbithole from your terminal to continue."); return; }
    var parent = nodes[currentNodeId];
    if (!parent || parent.status === "pending") return;
    var question = composerText.value.trim();
    if (!question) return;
    sendFollowup(parent, question, null);
    composerText.value = "";
    autoGrowComposer();
    updateComposerState();
    animateScroll(readerMain, readerMain.scrollHeight, source);
  }

  // Undo an optimistic branch whose request the server rejected/never received.
  // No-op if the node is already gone, or if an answer raced in ahead of the
  // failed-POST callback (don't delete a node the agent actually answered).
export function rollbackBranch(node){
    var live = nodes[node.id];
    if (!live || live.status === "answered") return;
    delete nodes[node.id];
    if (node.el && node.el.parentNode) node.el.parentNode.removeChild(node.el);
    removeMarks(readerMain, node.id);
    removeThreadItem(node.id);
    var p = nodes[node.parent_id];
    if (p && p.bodyEl) removeMarks(p.bodyEl, node.id);
    if (canvasBuilt) drawEdges();
    if (mode === "reader" && currentNodeId === node.parent_id) renderSidebar();
    refreshAmbient();
    flashHint("Couldn't reach the agent — that ask was undone.");
  }

export function subtreeBounds(node){
    return sharedSubtreeBounds(node, { childrenOf: childrenOf, effH: effH, sort: nodeOrder });
  }
export function placeChild(parent, branchType, childSize){
    return sharedPlaceChild(parent, branchType, {
      childrenOf: childrenOf,
      effH: effH,
      sort: nodeOrder,
      childSize: childSize || DEFAULT_CHILD
    });
  }

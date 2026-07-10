import { CANVAS_SHELL } from "../core/html/shell.js";
import { createBrain, defaultBrainSettings, presetFor, settingsForPreset, BRAIN_PRESETS } from "./brain/index.js";
import { IdbStore } from "./store/idb-store.js";
import { DirectRabbitholeHost, createHoleFromMarkdown } from "./transport/direct-host.js";
import { startRabbithole } from "../ui/entry.js";
import { setSnapshotHooks, buildSnapshotHydration, buildSnapshotHtml } from "../ui/snapshot.js";
import { openUrlToStoredHole } from "./ingest/url.js";

const SETTINGS_KEY = "rh-web-settings";
const KEY_KEY = "rh-web-api-key";
// The branch ref matters: main tracks upstream; the Warren patches (config
// lenses, page-size cards, team palette) live on warren-patches-v2.
const AGENT_COMMAND = "claude mcp add rabbithole -- npx -y github:helloprkr/rabbithole#warren-patches-v2";
const OPENROUTER_WALKTHROUGH_URL = "https://openrouter.ai/docs/quickstart";

// Warren patch 5 — team workspace mode. When the app is staged on a team hub,
// `workspace.json` sits beside index.html (written by `warren team workspace
// stage`). Its presence turns on: a team landing card, a sticky author handle
// (stamped as origin.author on every node the member makes), auto-open of the
// published team hole, and a background sync that POSTs novel nodes to the
// hub's /api/branches inbox — the hourly tick merges them attributed. Absent
// (personal/local use), everything below is dead code and the app is unchanged.
const TEAM_AUTHOR_KEY = "rh-team-author";
const TEAM_AUTHOR_RE = /^[a-z0-9_-]{1,32}$/;
const TEAM_SYNC_EVERY_MS = 20000;

const store = new IdbStore();
let memoryKey = "";
let currentHost = null;
let currentHoleId = null;
let uiStarted = false;
let teamConfig = null;
let teamHoleLocalId = "";
let teamSyncTimer = null;
let teamSyncBusy = false;

applyInitialWebTheme();

boot().catch((err) => {
  document.body.innerHTML = `<main class="web-fatal"><h1>Rabbithole</h1><p>${escapeHtml(err?.message || String(err))}</p></main>`;
});

async function boot() {
  document.body.classList.add("web-app");
  teamConfig = await loadTeamConfig();
  const holeId = holeIdFromHash();
  if (holeId) {
    const hole = await store.loadHole(holeId);
    if (!hole) {
      history.replaceState(null, "", location.pathname);
      await renderHome();
      return;
    }
    await startHole(hole, { replace: true });
  } else {
    await renderHome();
  }
}

async function renderHome() {
  uiStarted = false;
  currentHost = null;
  currentHoleId = null;
  document.documentElement.classList.add("web-home-active");
  document.documentElement.classList.remove("web-canvas-active");
  document.body.classList.remove("mode-canvas");
  document.body.innerHTML = `<main class="web-home">
    <header class="home-hero">
      <div class="home-nav">
        <div class="home-wordmark">
          <span class="home-mark">${bunnyMarkSvg()}</span>
          <h1>Rabbithole</h1>
        </div>
        <button class="web-secondary settings-open" id="settings-open" type="button" aria-controls="settings-panel" aria-expanded="false">Settings</button>
      </div>
      <p class="home-promise">An infinite canvas for learning.</p>
      <p class="home-lede">Open a document, select what makes you curious, ask, and the answer opens beside it.</p>
    </header>

    <section class="hole-list-wrap" id="saved-section" hidden>
      <div class="hole-list-head">
        <h2>Saved holes</h2>
        <button id="refresh-list" class="web-secondary" type="button">Refresh</button>
      </div>
      <div id="hole-list" class="hole-list"></div>
    </section>

    ${teamConfig ? teamCardHtml() : ""}

    <section class="new-hole" aria-labelledby="composer-heading">
      <div class="new-hole-main">
        <div class="composer-head">
          <div>
            <h2 id="composer-heading">Open a document</h2>
            <p>Paste markdown, drop a PDF, or open a URL.</p>
          </div>
          <label class="drop-md" id="drop-md">
            <input id="file-md" type="file" accept=".md,.pdf,text/markdown,text/plain,application/pdf">
            <span>Choose file</span>
          </label>
        </div>
        <label class="field title-field" for="new-title">
          <span>Title</span>
          <input id="new-title" class="web-input" placeholder="Untitled Rabbithole" autocomplete="off">
        </label>
        <label class="field paste-field" for="paste-md">
          <span>Markdown or notes</span>
          <textarea id="paste-md" class="paste-md" placeholder="Paste markdown, notes, or source text here."></textarea>
        </label>
        <div class="composer-footer">
          <p class="drop-hint">Drop .md or .pdf anywhere here.</p>
          <button id="create-hole" class="web-primary" type="button">Open on the canvas</button>
        </div>
        <div class="url-open-row">
          <label class="field url-field" for="open-url-input">
            <span>URL</span>
            <input id="open-url-input" class="web-input" placeholder="https://example.com/paper.pdf" inputmode="url" autocomplete="url">
          </label>
          <button id="open-url" class="web-secondary" type="button">Open URL</button>
        </div>
        <div id="ingest-status" class="ingest-status" aria-live="polite"></div>
      </div>
    </section>

    <section class="settings-panel home-settings" id="settings-panel" aria-label="AI provider settings"></section>

    <section class="home-footnotes" aria-label="Setup notes">
      <span id="empty-note" class="empty-note" hidden>No saved holes yet.</span>
      <a href="${OPENROUTER_WALKTHROUGH_URL}" target="_blank" rel="noreferrer">30-second OpenRouter key walkthrough</a>
      <span class="agent-path">Using a coding agent? <code>${escapeHtml(AGENT_COMMAND)}</code> <button class="copy-command" type="button" data-copy-agent>Copy</button></span>
    </section>
  </main><div id="web-toast" class="web-toast" aria-live="polite"></div>`;

  initSettingsPanel();
  const settings = loadSettings();
  const needsKey = presetFor(settings.preset).requires_key && !getApiKey(settings);
  const settingsPanel = document.getElementById("settings-panel");
  const settingsOpen = document.getElementById("settings-open");
  settingsPanel.classList.toggle("expanded", needsKey);
  settingsPanel.classList.toggle("needs-key", needsKey);
  settingsOpen.setAttribute("aria-expanded", settingsPanel.classList.contains("expanded") ? "true" : "false");
  document.getElementById("settings-open").addEventListener("click", () => {
    settingsPanel.classList.toggle("expanded");
    settingsOpen.setAttribute("aria-expanded", settingsPanel.classList.contains("expanded") ? "true" : "false");
    if (settingsPanel.classList.contains("expanded")) {
      settingsPanel.querySelector("select, input, button, summary")?.focus();
    }
  });
  document.getElementById("create-hole").addEventListener("click", createFromPaste);
  document.getElementById("open-url").addEventListener("click", createFromUrl);
  document.getElementById("open-url-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createFromUrl();
    }
  });
  document.getElementById("refresh-list").addEventListener("click", renderHoleList);
  document.querySelectorAll("[data-copy-agent]").forEach((button) => {
    button.addEventListener("click", () => copyText(AGENT_COMMAND, "Command copied."));
  });
  if (teamConfig) initTeamCard();
  initDrop();
  await renderHoleList();
}

// ---------------------------------------------------------------------------
// Team workspace mode (Warren patch 5)
// ---------------------------------------------------------------------------

async function loadTeamConfig() {
  try {
    const res = await fetch("workspace.json", { cache: "no-store" });
    if (!res.ok) return null;
    const cfg = await res.json();
    if (!cfg || typeof cfg !== "object" || typeof cfg.project !== "string" || !cfg.project) return null;
    return {
      project: cfg.project,
      hole: typeof cfg.hole === "string" && cfg.hole ? cfg.hole : "",
      branchEndpoint: typeof cfg.branchEndpoint === "string" && cfg.branchEndpoint ? cfg.branchEndpoint : "/api/branches",
    };
  } catch {
    return null;
  }
}

function teamAuthor() {
  try {
    const a = localStorage.getItem(TEAM_AUTHOR_KEY) || "";
    return TEAM_AUTHOR_RE.test(a) ? a : "";
  } catch {
    return "";
  }
}

function slugifyAuthor(raw) {
  return String(raw || "").trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

function teamProjectTitle() {
  return String(teamConfig?.project || "")
    .split("-")
    .map((word) => (word ? word[0].toUpperCase() + word.slice(1) : ""))
    .join(" ");
}

function teamCardHtml() {
  const author = teamAuthor();
  return `<section class="new-hole team-card" aria-labelledby="team-heading">
    <div class="new-hole-main">
      <div class="composer-head">
        <div>
          <h2 id="team-heading">${escapeHtml(teamProjectTitle())} — team warren</h2>
          <p>Everything you make here carries your name and flows back to the group overnight.</p>
        </div>
      </div>
      <div class="team-signin" id="team-signin">${teamSigninHtml(author)}</div>
      ${teamConfig.hole ? `<div class="composer-footer">
        <p class="drop-hint" id="team-open-hint">${author ? "" : "Pick your name first."}</p>
        <button id="team-open" class="web-primary" type="button" ${author ? "" : "disabled"}>Open the team canvas</button>
      </div>` : ""}
      <div id="team-status" class="ingest-status" aria-live="polite"></div>
      <details class="team-agent-path">
        <summary>Prefer your own AI subscription (Claude Code, Codex)? No API key needed.</summary>
        <div class="team-agent-steps">
          <p>1. In a terminal, add the canvas to your agent (one time):</p>
          <p><code>${escapeHtml(AGENT_COMMAND)}</code> <button class="copy-command" type="button" data-copy-agent>Copy</button></p>
          <p class="team-agent-note">Codex or another MCP-capable agent? Same server: <code>codex mcp add rabbithole -- npx -y github:helloprkr/rabbithole#warren-patches-v2</code></p>
          <p>2. Then paste this into your agent (fill in the team key you signed in with):</p>
          <p><code id="team-agent-prompt">${escapeHtml(teamAgentPrompt(author))}</code> <button class="copy-command" type="button" data-copy-agent-prompt>Copy</button></p>
          <p class="team-agent-note">Your subscription does the answering; your work still lands back here with your name on it.</p>
        </div>
      </details>
    </div>
  </section>`;
}

function teamSigninHtml(author) {
  if (author) {
    return `<p class="team-signed-in">You are <strong>${escapeHtml(author)}</strong> — this name is stamped on every card you make.
      <button id="team-author-change" class="web-secondary" type="button">Change</button></p>`;
  }
  return `<label class="field" for="team-author-input">
      <span>Your name or handle (you keep it forever — changing it later splits your history)</span>
      <input id="team-author-input" class="web-input" placeholder="e.g. jordan, orph, zy" autocomplete="off" maxlength="40">
    </label>
    <button id="team-author-save" class="web-primary" type="button">Sign in</button>`;
}

function teamAgentPrompt(author) {
  const origin = location.origin;
  const slug = teamConfig?.hole || "<team-hole>";
  const name = author || "<your-name>";
  return `Our team hub is ${origin} (access key: <TEAM KEY>). Authenticate (the ?k= query sets a cookie), download ${origin}/h/${slug}/hole.json to a local file, and resume that rabbithole file. I am "${name}" — set origin.author="${name}" on every node you create. When I say "sync to team", POST {v:1, hole:"${slug}", author:"${name}", nodes:[the novel nodes: id, parent_id, title, markdown, origin]} to ${origin}/api/branches with the same auth.`;
}

function initTeamCard() {
  wireTeamSignin();
  const openBtn = document.getElementById("team-open");
  if (openBtn) openBtn.addEventListener("click", () => openTeamHole());
  document.querySelectorAll("[data-copy-agent-prompt]").forEach((button) => {
    button.addEventListener("click", () => copyText(teamAgentPrompt(teamAuthor()), "Prompt copied — fill in the team key."));
  });
}

function wireTeamSignin() {
  const saveBtn = document.getElementById("team-author-save");
  const changeBtn = document.getElementById("team-author-change");
  if (saveBtn) {
    const input = document.getElementById("team-author-input");
    const save = () => {
      const slug = slugifyAuthor(input.value);
      if (!TEAM_AUTHOR_RE.test(slug)) {
        setTeamStatus("Names are 1–32 lowercase letters, numbers, dashes or underscores.", "error");
        return;
      }
      try { localStorage.setItem(TEAM_AUTHOR_KEY, slug); } catch {}
      setTeamStatus("");
      refreshTeamCard();
      showToast({ message: `Signed in as ${slug}. Stick with this name.` });
    };
    saveBtn.addEventListener("click", save);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") { event.preventDefault(); save(); }
    });
  }
  if (changeBtn) {
    changeBtn.addEventListener("click", () => {
      if (!confirm("Changing your name splits your attribution history. Your old cards keep the old name. Continue?")) return;
      try { localStorage.removeItem(TEAM_AUTHOR_KEY); } catch {}
      refreshTeamCard();
    });
  }
}

function refreshTeamCard() {
  const signin = document.getElementById("team-signin");
  if (signin) signin.innerHTML = teamSigninHtml(teamAuthor());
  const author = teamAuthor();
  const openBtn = document.getElementById("team-open");
  const hint = document.getElementById("team-open-hint");
  if (openBtn) openBtn.disabled = !author;
  if (hint) hint.textContent = author ? "" : "Pick your name first.";
  const prompt = document.getElementById("team-agent-prompt");
  if (prompt) prompt.textContent = teamAgentPrompt(author);
  wireTeamSignin();
}

function setTeamStatus(message, tone = "") {
  const el = document.getElementById("team-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `ingest-status${message ? " visible" : ""}${tone ? ` ${tone}` : ""}`;
}

function teamHoleStorageKey() {
  return `rh-team-hole:${teamConfig?.hole || ""}`;
}

function teamSyncedStorageKey(holeId) {
  return `rh-team-synced:${holeId}`;
}

async function openTeamHole() {
  if (!teamConfig?.hole) return;
  let localId = "";
  try { localId = localStorage.getItem(teamHoleStorageKey()) || ""; } catch {}
  if (localId) {
    const existing = await store.loadHole(localId);
    if (existing) { await startHole(existing); return; }
  }
  setTeamStatus("Fetching the team hole…", "busy");
  let hole;
  try {
    const res = await fetch(`../h/${encodeURIComponent(teamConfig.hole)}/hole.json`, { cache: "no-store" });
    if (!res.ok) {
      setTeamStatus(`Couldn't fetch the team hole (${res.status}). Are you signed in with the team key?`, "error");
      return;
    }
    hole = await res.json();
  } catch (err) {
    setTeamStatus(`Couldn't fetch the team hole. ${err?.message || String(err)}`, "error");
    return;
  }
  if (!hole || typeof hole !== "object" || !hole.hole_id || !Array.isArray(hole.nodes)) {
    setTeamStatus("The team hole file looks malformed — tell the toolkeeper.", "error");
    return;
  }
  await store.saveHole(hole);
  try {
    localStorage.setItem(teamHoleStorageKey(), hole.hole_id);
    // Everything fetched from the hub is already the team's — only nodes made
    // HERE after this baseline are novel and get synced up.
    localStorage.setItem(teamSyncedStorageKey(hole.hole_id), JSON.stringify(hole.nodes.map((n) => n.id)));
  } catch {}
  setTeamStatus("");
  await startHole(await store.loadHole(hole.hole_id) || hole);
}

function isTeamHole(holeId) {
  if (!teamConfig?.hole || !holeId) return false;
  try { return localStorage.getItem(teamHoleStorageKey()) === holeId; } catch { return false; }
}

function startTeamSync() {
  if (teamSyncTimer) clearInterval(teamSyncTimer);
  teamSyncTimer = setInterval(() => { teamSyncNow(true).catch(() => {}); }, TEAM_SYNC_EVERY_MS);
}

async function teamSyncNow(silent = false) {
  if (teamSyncBusy) return;
  if (!teamConfig || !currentHoleId || currentHoleId !== teamHoleLocalId) return;
  const author = teamAuthor();
  if (!author) return;
  teamSyncBusy = true;
  try {
    const hole = await store.loadHole(currentHoleId);
    if (!hole || !Array.isArray(hole.nodes)) return;
    let synced = [];
    try { synced = JSON.parse(localStorage.getItem(teamSyncedStorageKey(currentHoleId)) || "[]"); } catch {}
    const syncedSet = new Set(Array.isArray(synced) ? synced : []);
    const novel = hole.nodes.filter((n) => n && typeof n.id === "string" && n.id && !syncedSet.has(n.id));
    if (!novel.length) {
      if (!silent) showToast({ message: "Everything here is already synced to the team." });
      return;
    }
    const payload = {
      v: 1,
      hole: teamConfig.hole,
      author,
      nodes: novel.slice(0, 500).map((n) => ({
        id: n.id,
        parent_id: n.parent_id ?? null,
        title: typeof n.title === "string" ? n.title : "",
        markdown: typeof n.markdown === "string" ? n.markdown : "",
        origin: { ...(n.origin && typeof n.origin === "object" ? n.origin : {}), author },
        ...(n.position && Number.isFinite(n.position.x) && Number.isFinite(n.position.y)
          ? { position: { x: n.position.x, y: n.position.y } }
          : {}),
        ...(typeof n.created_at === "string" ? { created_at: n.created_at } : {}),
      })),
    };
    let res;
    try {
      res = await fetch(teamConfig.branchEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        keepalive: true,
      });
    } catch {
      if (!silent) showToast({ message: "Team sync failed — network. Your work is safe locally; it retries." });
      return;
    }
    if (res.status === 202) {
      for (const n of novel) syncedSet.add(n.id);
      try { localStorage.setItem(teamSyncedStorageKey(currentHoleId), JSON.stringify([...syncedSet])); } catch {}
      if (!silent) showToast({ message: `Sent ${novel.length} node${novel.length === 1 ? "" : "s"} to the team.` });
    } else if (!silent) {
      showToast({ message: `Team sync failed (${res.status}). Your work is safe locally; it retries.` });
    }
  } finally {
    teamSyncBusy = false;
  }
}

async function renderHoleList() {
  const listEl = document.getElementById("hole-list");
  if (!listEl) return;
  const savedSection = document.getElementById("saved-section");
  const emptyNote = document.getElementById("empty-note");
  const holes = await store.listHoles();
  if (!holes.length) {
    listEl.innerHTML = "";
    if (savedSection) savedSection.hidden = true;
    if (emptyNote) emptyNote.hidden = false;
    return;
  }
  if (savedSection) savedSection.hidden = false;
  if (emptyNote) emptyNote.hidden = true;
  listEl.innerHTML = holes.map((hole) => `<article class="hole-row" data-hole="${escapeAttr(hole.hole_id)}">
    <button class="hole-open" type="button">
      <span class="hole-title">${escapeHtml(hole.title || "Untitled")}</span>
      <span class="hole-meta"><span>${escapeHtml(formatRelativeDate(hole.updated_at))}</span><span>${hole.node_count} ${hole.node_count === 1 ? "node" : "nodes"}</span></span>
    </button>
    <button class="hole-delete" type="button" aria-label="Delete ${escapeAttr(hole.title || "Untitled")}">Delete</button>
  </article>`).join("");
  listEl.querySelectorAll(".hole-open").forEach((button) => {
    button.addEventListener("click", async () => {
      const row = button.closest(".hole-row");
      const hole = await store.loadHole(row.dataset.hole);
      if (hole) await startHole(hole);
    });
  });
  listEl.querySelectorAll(".hole-delete").forEach((button) => {
    button.addEventListener("click", () => deleteHoleFromHome(button.closest(".hole-row").dataset.hole));
  });
}

async function createFromPaste() {
  const title = document.getElementById("new-title").value.trim();
  const markdown = document.getElementById("paste-md").value.trim();
  if (!markdown) {
    showToast({ message: "Paste markdown first." });
    return;
  }
  const hole = createHoleFromMarkdown({ title, markdown });
  await store.saveHole(hole);
  await startHole(await store.loadHole(hole.hole_id) || hole);
}

function initDrop() {
  const drop = document.getElementById("drop-md");
  const zone = document.querySelector(".new-hole");
  const input = document.getElementById("file-md");
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (file) await createFromFile(file);
    input.value = "";
  });
  for (const type of ["dragenter", "dragover"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.add("dragging");
      drop.classList.add("dragging");
    });
  }
  for (const type of ["dragleave", "drop"]) {
    zone.addEventListener(type, (event) => {
      event.preventDefault();
      zone.classList.remove("dragging");
      drop.classList.remove("dragging");
    });
  }
  zone.addEventListener("drop", async (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) await createFromFile(file);
  });
}

async function createFromFile(file) {
  if (isPdfFile(file)) {
    await createFromPdfFile(file);
    return;
  }
  if (!isMarkdownFile(file)) {
    setIngestStatus("Choose a markdown or PDF file.", "error");
    return;
  }
  try {
    setIngestStatus("Reading markdown file...", "busy");
    const markdown = await file.text();
    const title = document.getElementById("new-title").value.trim() || file.name.replace(/\.[^.]+$/, "");
    const hole = createHoleFromMarkdown({ title, markdown });
    await store.saveHole(hole);
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`Markdown import failed. ${err?.message || String(err)}`, "error");
  }
}

async function createFromPdfFile(file) {
  try {
    const { ingestPdfToStoredHole } = await import("./ingest/pdf.js");
    setIngestStatus("Loading PDF importer...", "busy");
    const title = document.getElementById("new-title").value.trim();
    const { hole } = await ingestPdfToStoredHole({
      source: file,
      store,
      title,
      onProgress: ({ page, index, total }) => {
        if (page) setIngestStatus(`Importing PDF page ${index}/${total}...`, "busy");
      },
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(`PDF import failed. ${err?.message || String(err)} Paste the text manually or drop a different PDF.`, "error");
  }
}

async function createFromUrl() {
  const rawUrl = document.getElementById("open-url-input").value.trim();
  if (!rawUrl) {
    setIngestStatus("Enter a URL first.", "error");
    return;
  }
  try {
    const settings = loadSettings();
    const title = document.getElementById("new-title").value.trim();
    setIngestStatus("Fetching URL...", "busy");
    const { hole } = await openUrlToStoredHole({
      rawUrl,
      store,
      title,
      proxyBaseUrl: settings.fetch_proxy_url || "",
      onProgress: (progress) => {
        if (progress.phase === "fetch") setIngestStatus(`Fetching URL via ${progress.via}...`, "busy");
        else if (progress.phase === "page") setIngestStatus(`Importing PDF page ${progress.index}/${progress.total}...`, "busy");
      },
    });
    setIngestStatus("");
    await startHole(await store.loadHole(hole.hole_id) || hole);
  } catch (err) {
    setIngestStatus(err?.message || String(err), "error");
  }
}

async function deleteHoleFromHome(holeId) {
  const hole = await store.loadHole(holeId);
  if (!hole) return;
  const assets = [];
  for (const name of await store.listAssets(holeId)) {
    assets.push({ name, blob: await store.getAsset(holeId, name) });
  }
  await store.deleteHole(holeId);
  await renderHoleList();
  showToast({
    message: `Deleted "${hole.title || "Untitled"}"`,
    actionLabel: "Undo",
    timeoutMs: 10000,
    onAction: async () => {
      await store.saveHole(hole);
      for (const asset of assets) {
        if (asset.blob) await store.putAsset(holeId, asset.name, asset.blob);
      }
      await renderHoleList();
    },
  });
}

async function startHole(hole, { replace = false } = {}) {
  if (uiStarted) {
    location.hash = `hole=${encodeURIComponent(hole.hole_id)}`;
    location.reload();
    return;
  }
  uiStarted = true;
  currentHoleId = hole.hole_id;
  document.documentElement.classList.remove("web-home-active");
  document.documentElement.classList.add("web-canvas-active");
  if (replace) history.replaceState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);
  else history.pushState(null, "", `#hole=${encodeURIComponent(hole.hole_id)}`);

  const teamMode = isTeamHole(hole.hole_id);
  teamHoleLocalId = teamMode ? hole.hole_id : "";
  document.body.innerHTML = `<div class="web-canvas-bar">
    <button id="web-home" class="web-secondary" type="button">Home</button>
    <button id="web-settings" class="web-secondary" type="button">Settings</button>
    ${teamMode ? `<span class="team-badge">team · ${escapeHtml(teamAuthor())}</span>
    <button id="team-sync" class="web-secondary" type="button">Send to team</button>` : ""}
  </div>
  <div id="web-settings-modal" class="web-settings-modal" hidden><div class="web-settings-dialog"><button id="web-settings-close" class="web-close" type="button">Close</button><div id="settings-panel" class="settings-panel expanded"></div></div></div>
  <div id="canvas-root">${CANVAS_SHELL}</div>
  <div id="web-toast" class="web-toast" aria-live="polite"></div>`;

  initCanvasSettings();
  setSnapshotHooks({
    fetchAssetData: async (name) => blobToDataUrl(await store.getAsset(currentHoleId, name)),
    getFrozenClientSource: () => window.__RABBITHOLE_FROZEN_CLIENT__ || "",
    getDompurifySource: () => window.__RABBITHOLE_DOMPURIFY_SOURCE__ || "",
  });

  const settings = loadSettings();
  const key = getApiKey(settings);
  const brain = key || !presetFor(settings.preset).requires_key ? createBrain(settings, key) : null;
  currentHost = new DirectRabbitholeHost({
    store,
    hole,
    brain,
    onToast: showToast,
    onDone: () => {
      history.pushState(null, "", location.pathname);
      location.reload();
    },
    onRestore: () => location.reload(),
  });

  const hydration = currentHost.hydration();
  hydration.asset_data = await buildLiveAssetData(hole.hole_id);
  startRabbithole(hydration, { transport: currentHost.adapter() });

  document.getElementById("web-home").addEventListener("click", async () => {
    await currentHost?.flushSave();
    if (teamMode) await teamSyncNow(true).catch(() => {});
    history.pushState(null, "", location.pathname);
    location.reload();
  });

  if (teamMode) {
    document.getElementById("team-sync").addEventListener("click", async () => {
      await currentHost?.flushSave();
      await teamSyncNow(false);
    });
    startTeamSync();
  }

  window.__rhWebApp = {
    store,
    exportSnapshotForTest: async () => buildSnapshotHtml(await buildSnapshotHydration()),
    currentHoleId: () => currentHoleId,
    readRawHole: (id = currentHoleId) => store.readRawHoleForTest(id),
    teamSyncNow: (silent = false) => teamSyncNow(silent),
  };
}

function initCanvasSettings() {
  const modal = document.getElementById("web-settings-modal");
  const open = document.getElementById("web-settings");
  const close = document.getElementById("web-settings-close");
  initSettingsPanel();
  open.addEventListener("click", () => {
    modal.hidden = false;
    modal.querySelector("input, select, button")?.focus();
  });
  close.addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (event) => {
    if (event.target === modal) modal.hidden = true;
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") modal.hidden = true;
  });
}

function initSettingsPanel() {
  const panel = document.getElementById("settings-panel");
  const settings = loadSettings();
  const presetOptions = Object.values(BRAIN_PRESETS).map((preset) => {
    const label = preset.recommended ? `${preset.label} (recommended)` : preset.label;
    return `<option value="${preset.id}" ${settings.preset === preset.id ? "selected" : ""}>${escapeHtml(label)}</option>`;
  }).join("");
  panel.dataset.preset = presetFor(settings.preset).id;
  panel.innerHTML = `<div class="settings-inner">
    <div class="settings-head">
      <div>
        <h2>Provider settings</h2>
        <p>Connect the model Rabbithole uses when you ask from a selection.</p>
      </div>
    </div>
    <div class="settings-basic">
      <label class="field provider-field" for="provider-preset">
        <span>Provider</span>
        <select id="provider-preset">${presetOptions}</select>
      </label>
      <label class="field custom-only" for="provider-base">
        <span>Base URL</span>
        <input id="provider-base" value="${escapeAttr(settings.base_url || "")}" placeholder="http://localhost:11434/v1">
      </label>
      <div class="field key-field">
        <label for="api-key">API key</label>
        <div class="secret-input">
          <input id="api-key" type="password" autocomplete="off" placeholder="${escapeAttr(apiKeyPlaceholder(settings.preset))}" value="${escapeAttr(getApiKey(settings))}">
          <button id="api-key-toggle" class="web-secondary" type="button" aria-label="Show API key" aria-pressed="false">Show</button>
        </div>
      </div>
      <label class="switch-field" for="session-only">
        <input id="session-only" type="checkbox" role="switch" ${settings.session_only !== false ? "checked" : ""}>
        <span class="switch-track" aria-hidden="true"></span>
        <span class="switch-copy"><strong>Session only</strong><small>Keep this key in memory for this tab.</small></span>
      </label>
    </div>
    <details class="settings-advanced">
      <summary>Advanced</summary>
      <div class="settings-advanced-grid">
        <label class="field" for="answer-model">
          <span>Answer model</span>
          <input id="answer-model" value="${escapeAttr(settings.answer_model || "")}">
        </label>
        <label class="field" for="author-model">
          <span>Author model</span>
          <input id="author-model" value="${escapeAttr(settings.author_model || "")}">
        </label>
        <label class="field wide-field" for="fetch-proxy-url">
          <span>Fetch proxy URL</span>
          <input id="fetch-proxy-url" value="${escapeAttr(settings.fetch_proxy_url || "")}" placeholder="https://your-worker.example/?url=">
        </label>
        <p class="custom-csp-note wide-field">Custom remote origins require editing this static app's CSP. Localhost custom endpoints are allowed by default.</p>
      </div>
    </details>
    <div class="settings-actions">
      <a class="key-walkthrough" href="${OPENROUTER_WALKTHROUGH_URL}" target="_blank" rel="noreferrer">30-second OpenRouter key walkthrough</a>
      <button id="save-settings" class="web-primary" type="button">Save settings</button>
    </div>
  </div>`;

  panel.querySelector("#provider-preset").addEventListener("change", (event) => {
    const next = settingsForPreset(event.target.value, readSettingsForm());
    panel.dataset.preset = next.preset;
    panel.querySelector("#provider-base").value = next.base_url;
    panel.querySelector("#answer-model").value = next.answer_model;
    panel.querySelector("#author-model").value = next.author_model;
    panel.querySelector("#api-key").placeholder = apiKeyPlaceholder(next.preset);
  });
  panel.querySelector("#api-key-toggle").addEventListener("click", () => {
    const input = panel.querySelector("#api-key");
    const showing = input.type === "text";
    input.type = showing ? "password" : "text";
    const button = panel.querySelector("#api-key-toggle");
    button.textContent = showing ? "Show" : "Hide";
    button.setAttribute("aria-label", showing ? "Show API key" : "Hide API key");
    button.setAttribute("aria-pressed", showing ? "false" : "true");
  });
  panel.querySelector("#save-settings").addEventListener("click", () => {
    const next = readSettingsForm();
    saveSettings(next);
    showToast({ message: "Settings saved." });
    panel.classList.toggle("needs-key", presetFor(next.preset).requires_key && !getApiKey(next));
    if (currentHost) {
      const key = getApiKey(next);
      currentHost.brain = key || !presetFor(next.preset).requires_key ? createBrain(next, key) : null;
    }
  });
}

function readSettingsForm() {
  const sessionOnly = document.getElementById("session-only")?.checked !== false;
  return {
    preset: document.getElementById("provider-preset")?.value || "openrouter",
    base_url: document.getElementById("provider-base")?.value.trim() || "",
    author_model: document.getElementById("author-model")?.value.trim() || "",
    answer_model: document.getElementById("answer-model")?.value.trim() || "",
    fetch_proxy_url: document.getElementById("fetch-proxy-url")?.value.trim() || "",
    session_only: sessionOnly,
    api_key: document.getElementById("api-key")?.value || "",
  };
}

function loadSettings() {
  try {
    return { ...defaultBrainSettings(), ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}")) };
  } catch {
    return defaultBrainSettings();
  }
}

function saveSettings(settings) {
  const { api_key, ...persistable } = settings;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(persistable));
  if (settings.session_only === false) {
    localStorage.setItem(KEY_KEY, api_key || "");
    memoryKey = "";
  } else {
    localStorage.removeItem(KEY_KEY);
    memoryKey = api_key || "";
  }
}

function getApiKey(settings) {
  if (settings.session_only === false) {
    try { return localStorage.getItem(KEY_KEY) || ""; } catch { return ""; }
  }
  return memoryKey;
}

async function buildLiveAssetData(holeId) {
  const out = {};
  for (const name of await store.listAssets(holeId)) {
    const blob = await store.getAsset(holeId, name);
    if (blob) out[name] = URL.createObjectURL(blob);
  }
  return out;
}

function showToast({ message, actionLabel = "", timeoutMs = 4000, onAction = null } = {}) {
  const el = document.getElementById("web-toast");
  if (!el) return;
  el.innerHTML = `<span>${escapeHtml(message || "")}</span>${actionLabel ? `<button type="button">${escapeHtml(actionLabel)}</button>` : ""}`;
  el.classList.add("visible");
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    el.classList.remove("visible");
  };
  const timer = setTimeout(finish, timeoutMs);
  const button = el.querySelector("button");
  if (button) {
    button.addEventListener("click", async () => {
      clearTimeout(timer);
      await onAction?.();
      finish();
    }, { once: true });
  }
}

function setIngestStatus(message, tone = "") {
  const el = document.getElementById("ingest-status");
  if (!el) return;
  el.textContent = message || "";
  el.className = `ingest-status${message ? " visible" : ""}${tone ? ` ${tone}` : ""}`;
}

function isPdfFile(file) {
  return /(\.pdf$|application\/pdf)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function isMarkdownFile(file) {
  return /(\.md$|\.markdown$|markdown|text\/plain)/i.test(`${file?.name || ""} ${file?.type || ""}`);
}

function holeIdFromHash() {
  const match = /^#hole=(.+)$/.exec(location.hash || "");
  return match ? decodeURIComponent(match[1]) : "";
}

function formatRelativeDate(value) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "Updated at an unknown time";
  const deltaSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const ranges = [
    [60, "second", 1],
    [60 * 60, "minute", 60],
    [60 * 60 * 24, "hour", 60 * 60],
    [60 * 60 * 24 * 30, "day", 60 * 60 * 24],
    [60 * 60 * 24 * 365, "month", 60 * 60 * 24 * 30],
    [Infinity, "year", 60 * 60 * 24 * 365],
  ];
  try {
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    const [, unit, divisor] = ranges.find(([limit]) => abs < limit);
    return `Updated ${formatter.format(Math.round(deltaSeconds / divisor), unit)}`;
  } catch {
    return `Updated ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
  }
}

function blobToDataUrl(blob) {
  if (!blob) return Promise.resolve("data:,");
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "data:,"));
    reader.onerror = () => resolve("data:,");
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function applyInitialWebTheme() {
  try {
    let savedTheme = localStorage.getItem("rh-theme");
    if (savedTheme !== "dark" && savedTheme !== "light") savedTheme = "";
    if (!savedTheme && window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches) savedTheme = "dark";
    if (savedTheme) document.documentElement.setAttribute("data-theme", savedTheme);
  } catch {}
}

async function copyText(text, message) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    fallbackCopyText(text);
  }
  showToast({ message });
}

function fallbackCopyText(text) {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.left = "-999px";
  document.body.append(area);
  area.select();
  try { document.execCommand("copy"); } catch {}
  area.remove();
}

function apiKeyPlaceholder(presetId) {
  switch (presetFor(presetId).id) {
    case "openrouter": return "sk-or-v1-...";
    case "anthropic": return "sk-ant-...";
    case "openai": return "sk-...";
    default: return "optional";
  }
}

function bunnyMarkSvg() {
  return `<svg width="24" height="24" viewBox="0 0 64 64" fill="currentColor" aria-hidden="true">
    <ellipse cx="30" cy="17" rx="4.6" ry="12.5" transform="rotate(20 30 17)"></ellipse>
    <ellipse cx="21.5" cy="15.5" rx="4.6" ry="13" transform="rotate(3 21.5 15.5)"></ellipse>
    <circle cx="21" cy="33" r="9.5"></circle>
    <ellipse cx="36" cy="45" rx="17" ry="13.5"></ellipse>
    <circle cx="52.5" cy="49" r="5"></circle>
  </svg>`;
}

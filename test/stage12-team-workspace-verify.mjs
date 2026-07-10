import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

// Stage 12 — team workspace mode (Warren patch 5). When workspace.json sits
// beside the web app, the home shows a team card; a member signs in once with
// a sticky handle, opens the published team hole fetched from /h/<slug>/hole.json,
// and their NOVEL nodes (and only those) POST to /api/branches stamped with
// origin.author. Without workspace.json the app is byte-for-byte the personal
// canvas: no team card.

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const WEB_DIST = path.join(ROOT, "web/dist");
const TEAM_SLUG = "encyclical-test";

try {
  await fs.access(path.join(WEB_DIST, "index.html"));
} catch {
  const build = spawnSync(process.execPath, ["build.mjs"], { cwd: ROOT, encoding: "utf8" });
  if (build.status !== 0) {
    process.stderr.write(build.stderr || build.stdout || "build failed\n");
    process.exit(build.status || 1);
  }
}

const teamHole = {
  hole_id: "teamhole1",
  title: "Team fixture",
  root_id: "n1",
  created_at: "2026-07-10T00:00:00.000Z",
  updated_at: "2026-07-10T00:00:00.000Z",
  view_state: {},
  nodes: [
    baseNode({ id: "n1", parent_id: null, title: "Root", markdown: "Root document body." }),
    baseNode({ id: "n2", parent_id: "n1", title: "Section", markdown: "A section." }),
  ],
};

const branchPosts = [];
const sseClients = [];
const teamServer = await serveDist(WEB_DIST, { team: true });
const plainServer = await serveDist(WEB_DIST, { team: false });
const teamUrl = `http://127.0.0.1:${teamServer.address().port}`;
const plainUrl = `http://127.0.0.1:${plainServer.address().port}`;
const browser = await chromium.launch();
const page = await browser.newPage();

try {
  // --- no workspace.json → no team card, personal canvas unchanged ----------
  await page.goto(plainUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#file-md");
  assert.equal(await page.locator("#team-heading").count(), 0, "team card must be absent without workspace.json");

  // --- team card renders from workspace.json --------------------------------
  await page.goto(teamUrl, { waitUntil: "networkidle" });
  await page.waitForSelector("#team-heading");
  assert.match(await page.textContent("#team-heading"), /Theological Alignment — team warren/);
  assert.ok(await page.locator("#team-open").isDisabled(), "open must be gated on sign-in");
  assert.equal(await page.locator("#file-md").count(), 0, "the team home must not offer the personal open-a-document composer");

  // --- sign-in slugifies and sticks -----------------------------------------
  await page.fill("#team-author-input", "Zy Smith!");
  await page.click("#team-author-save");
  await page.waitForSelector(".team-signed-in");
  assert.equal(await page.evaluate(() => localStorage.getItem("rh-team-author")), "zy-smith");
  assert.ok(!(await page.locator("#team-open").isDisabled()), "open unlocks after sign-in");
  const agentPrompt = await page.textContent("#team-agent-prompt");
  assert.ok(agentPrompt.includes('"zy-smith"'), "agent paste block is personalized");
  assert.ok(agentPrompt.includes(TEAM_SLUG), "agent paste block names the team hole");

  // --- open the team hole (fetched from /h/<slug>/hole.json) ----------------
  await page.click("#team-open");
  await page.waitForSelector(".team-badge");
  assert.match(await page.textContent(".team-badge"), /team · zy-smith/);



  // --- novel nodes (and only novel nodes) sync with origin.author -----------
  await page.evaluate(async () => {
    const hole = await window.__rhWebApp.store.loadHole("teamhole1");
    hole.nodes.push({
      id: "n3", parent_id: "n1", title: "My note", markdown: "hello from the browser",
      origin: {}, position: { x: 10, y: 10 }, size: null, collapsed: false,
      font_scale: 1, read: false, status: "complete", created_at: "2026-07-10T01:00:00.000Z",
    });
    await window.__rhWebApp.store.saveHole(hole);
    await window.__rhWebApp.teamSyncNow(true);
  });
  assert.equal(branchPosts.length, 1, "one branch submission expected");
  const sub = branchPosts[0];
  assert.equal(sub.v, 1);
  assert.equal(sub.hole, TEAM_SLUG);
  assert.equal(sub.author, "zy-smith");
  assert.equal(sub.nodes.length, 1, "baseline nodes must NOT be re-submitted");
  assert.equal(sub.nodes[0].id, "n3");
  assert.equal(sub.nodes[0].parent_id, "n1");
  assert.equal(sub.nodes[0].origin.author, "zy-smith");

  // --- idempotent: a second sync sends nothing ------------------------------
  await page.evaluate(() => window.__rhWebApp.teamSyncNow(true));
  assert.equal(branchPosts.length, 1, "already-synced nodes must not re-post");

  // --- down-sync: work merged on the hub pops into the open canvas ----------
  // The hub's hole.json grows a node (nightly merge / another member / an
  // agent-answered ask); a pull must ingest it, render it, and NOT echo it
  // back up as if it were local work.
  teamHole.nodes.push(baseNode({ id: "n4", parent_id: "n1", title: "Merged hub answer", markdown: "Landed via the hourly merge." }));
  const pulled = await page.evaluate(() => window.__rhWebApp.teamPullNow());
  assert.equal(pulled, 1, "one remote node should be ingested");
  await page.waitForFunction(async () => {
    const hole = await window.__rhWebApp.readRawHole();
    return hole && hole.nodes.some((n) => n.id === "n4");
  });
  // The reader shows asks in its sidebar; a merged document node becomes
  // visible as a card once the spatial canvas is open.
  await page.click("#r-canvas");
  await page.waitForFunction(() => document.body.classList.contains("mode-canvas")
    && document.body.textContent.includes("Merged hub answer"));
  const pulledAgain = await page.evaluate(() => window.__rhWebApp.teamPullNow());
  assert.equal(pulledAgain, 0, "a second pull must ingest nothing new");
  await page.evaluate(() => window.__rhWebApp.teamSyncNow(true));
  assert.equal(branchPosts.length, 1, "pulled hub nodes must never be POSTed back up");

  // --- live push: a branch POSTed to the hub streams straight onto the open
  // canvas (SSE), with no pull and no merge tick in between — the agent-path
  // (Claude Code via MCP) answer appears in seconds. Streamed nodes join the
  // synced set and are never echoed back up.
  await waitFor(() => sseClients.length > 0, "canvas subscribes to the branch stream");
  pushBranchEvent({
    ts: "2026-07-10T02:00:00.000Z",
    author: "agent-jordan",
    hole: TEAM_SLUG,
    nodes: [{ id: "n5", parent_id: "n1", title: "Live agent answer", markdown: "Pushed over SSE, no tick needed.", origin: { author: "agent-jordan" } }],
  });
  await page.waitForFunction(async () => {
    const hole = await window.__rhWebApp.readRawHole();
    return hole && hole.nodes.some((n) => n.id === "n5");
  });
  assert.ok(
    await page.waitForFunction(() => document.body.textContent.includes("Live agent answer")),
    "the streamed card renders on the open canvas",
  );
  await page.evaluate(() => window.__rhWebApp.teamSyncNow(true));
  assert.equal(branchPosts.length, 1, "streamed nodes must never be POSTed back up");

  // --- seed a PENDING stub (an ask whose stream died) for the post-reload tests.
  // Marked already-synced so the sync assertions below stay exact.
  await page.evaluate(async () => {
    const hole = await window.__rhWebApp.store.loadHole("teamhole1");
    hole.nodes.push({
      id: "n6", parent_id: "n1", title: "What does clew mean…",
      markdown: "",
      origin: { selected_text: "the first clue", question: "What does clew actually mean, at full length, beyond the header?", lens: null, anchor: null, author: "zy-smith" },
      position: { x: 40, y: 900 }, size: null, collapsed: false,
      font_scale: 1, read: false, status: "pending", created_at: "2026-07-10T03:00:00.000Z",
    });
    await window.__rhWebApp.store.saveHole(hole);
    const key = "rh-team-synced:teamhole1";
    const synced = JSON.parse(localStorage.getItem(key) || "[]");
    synced.push("n6");
    localStorage.setItem(key, JSON.stringify(synced));
  });

  // --- a reloaded key-less canvas announces itself instead of failing silently
  // (session-only keys live in page memory and clear when the browser discards
  // a long-idle tab; the #hole= boot path must surface that on open, not on
  // the first failed ask)
  // Not networkidle: the canvas now holds an ever-open SSE stream, so the network
  // never idles once team mode is live.
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".team-badge");
  await page.waitForSelector("#web-settings-modal:not([hidden])");
  await page.click("#web-settings-close");
  await page.waitForSelector("#web-settings-modal[hidden]", { state: "attached" });

  // --- the pending card carries its maker's chip, its FULL question, and Clews
  if (!(await page.evaluate(() => document.body.classList.contains("mode-canvas")))) {
    await page.click("#r-canvas");
    await page.waitForFunction(() => document.body.classList.contains("mode-canvas"));
  }
  await page.waitForFunction(() =>
    Array.from(document.querySelectorAll(".node-author")).some((el) => el.textContent === "zy-smith"));
  await page.waitForFunction(() => document.body.textContent.includes("What does clew actually mean, at full length, beyond the header?"));
  assert.ok(await page.evaluate(() => document.body.textContent.includes("Clewing")), "a waiting card is Clewing, not Thinking");
  assert.ok(await page.evaluate(() => !!document.querySelector(".loading-clew .clew-ball")), "the Clew ball indicator renders");
  assert.ok(await page.evaluate(() => document.getElementById("ask-attach-row").classList.contains("available")),
    "the web workspace wires the attach-a-document affordance into the ask popup");

  // --- an answer arriving over the stream for that SAME id lands IN PLACE
  await waitFor(() => sseClients.length > 0, "reloaded canvas re-subscribes to the stream");
  pushBranchEvent({
    ts: "2026-07-10T03:05:00.000Z",
    author: "clew",
    hole: TEAM_SLUG,
    nodes: [{ id: "n6", parent_id: "n1", title: "Clew, at length", markdown: "A clew is a wound ball of thread.", origin: { selected_text: "the first clue", question: "What does clew actually mean, at full length, beyond the header?", author: "zy-smith", answered_by: "clew" } }],
  });
  await page.waitForFunction(async () => {
    const hole = await window.__rhWebApp.readRawHole();
    const n = hole && hole.nodes.find((x) => x.id === "n6");
    return n && n.status === "answered" && n.markdown.includes("wound ball of thread");
  });
  await page.waitForFunction(() => document.body.textContent.includes("A clew is a wound ball of thread."));
  await page.evaluate(() => window.__rhWebApp.teamSyncNow(true));
  assert.equal(branchPosts.length, 1, "an in-place answer must never be POSTed back up");

  console.log("stage12 team workspace verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => teamServer.close(resolve));
  await new Promise((resolve) => plainServer.close(resolve));
}

async function waitFor(cond, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

function pushBranchEvent(record) {
  const frame = `event: branch\ndata: ${JSON.stringify(record)}\n\n`;
  for (const res of sseClients) res.write(frame);
}

function baseNode({ id, parent_id, title, markdown }) {
  return {
    id, parent_id, title, markdown,
    origin: {}, position: { x: 0, y: 0 }, size: null, collapsed: false,
    font_scale: 1, read: true, status: "complete", created_at: "2026-07-10T00:00:00.000Z",
  };
}

async function serveDist(rootDir, { team }) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (team && url.pathname === "/workspace.json") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ project: "theological-alignment", hole: TEAM_SLUG, branchEndpoint: "/api/branches" }));
      return;
    }
    if (team && url.pathname === `/h/${TEAM_SLUG}/hole.json`) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(teamHole));
      return;
    }
    if (team && url.pathname === "/api/branches/stream") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      res.write("retry: 3000\n\nevent: hello\ndata: {}\n\n");
      sseClients.push(res);
      res.on("close", () => {
        const i = sseClients.indexOf(res);
        if (i !== -1) sseClients.splice(i, 1);
      });
      return;
    }
    if (team && url.pathname === "/api/branches" && req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      branchPosts.push(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      res.writeHead(202, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ accepted: true }));
      return;
    }
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.resolve(rootDir, rel);
    if (!file.startsWith(rootDir)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const bytes = await fs.readFile(file);
      res.writeHead(200, { "Content-Type": contentType(file), "Cache-Control": "no-store" });
      res.end(bytes);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function contentType(file) {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".woff2")) return "font/woff2";
  if (file.endsWith(".ttf")) return "font/ttf";
  return "application/octet-stream";
}

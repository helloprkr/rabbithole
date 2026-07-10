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

  console.log("stage12 team workspace verification passed");
} finally {
  await browser.close();
  await new Promise((resolve) => teamServer.close(resolve));
  await new Promise((resolve) => plainServer.close(resolve));
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

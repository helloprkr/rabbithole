#!/usr/bin/env node
/*
 * Warren fork smoke test — the regression backstop for the two Warren patches,
 * re-ported to the upstream re-architecture (6c3a1ea).
 *
 * Upstream now ships a real stage suite (npm test); this script guards the
 * behavior those stages don't: the CONFIG-DRIVEN LENSES seam (Warren patch 1)
 * and the SAFE_IMG svg+xml allowance (Warren patch 2), end-to-end, in-process.
 *
 *   Renderer  — data:image/svg+xml;base64 survives as <img> (patch 2), while
 *               data:image/svg;base64 still works and javascript: is stripped.
 *   Lenses    — a config.json in RABBITHOLE_DIR reaches the page hydration,
 *               normalizeLens accepts a config lens id server-side, and the
 *               answered node is titled with the config label (patch 1).
 *   listHoles — config.json coexisting in the hole dir is not surfaced as a hole.
 *
 * Exit 0 = green. Any assertion throws and exits non-zero.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createMarkdownRenderer, encodeBase64Utf8 } from "../src/core/markdown.js";
import { openRabbithole, answerBranch } from "../src/node/index.js";
import { closeAllSessions, getSession } from "../src/node/sessions.js";
import { listHoles } from "../src/node/fs-store.js";

process.env.RABBITHOLE_NO_BROWSER = "1";
process.env.RABBITHOLE_MAX_BLOCK_MS = "50";
const DIR = await fs.mkdtemp(path.join(os.tmpdir(), "rabbithole-smoke-"));
process.env.RABBITHOLE_DIR = DIR;

// A config lens pack, mirroring the real Warren lenses (short `q`; full
// instructions live in CLAUDE.md keyed by id). Two is enough to prove the seam.
const CONFIG_LENSES = [
  { id: "steelman", label: "Steelman / Refute", q: "Steelman the strongest counterargument, then refute it." },
  { id: "visualize", label: "Visualize", q: "Draw the three altitudes of this idea." },
];
await fs.writeFile(path.join(DIR, "config.json"), JSON.stringify({ lenses: CONFIG_LENSES }, null, 2), "utf-8");

// A 1x1 transparent-ish SVG as an svg+xml data URI — the exact shape every
// existing Visualize node embeds.
const SVG_B64 = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64");
const SVG_XML_URI = `data:image/svg+xml;base64,${SVG_B64}`;
const SVG_PLAIN_URI = `data:image/svg;base64,${SVG_B64}`;

function includes(haystack, needle, message) {
  assert(haystack.includes(needle), message || `expected to include ${needle}`);
}

function parseHydration(html) {
  const marker = "var hydration = ";
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, "page should include inline hydration");
  const jsonStart = start + marker.length;
  const jsonEnd = html.indexOf(";\n", jsonStart);
  assert.notEqual(jsonEnd, -1, "hydration assignment should terminate");
  return JSON.parse(html.slice(jsonStart, jsonEnd));
}

async function postEvent(session, payload) {
  const res = await fetch(`${session.url}/events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200);
  return res.json();
}

function checkRenderer() {
  const renderer = createMarkdownRenderer({ encodeBase64: encodeBase64Utf8, resolveAssetUrl: (n) => `/assets/${n}` });
  const r = renderer.renderMarkdownToHtml.bind(renderer);

  // Warren patch 2: svg+xml data URIs must survive as <img>.
  const svgXml = r(`![v](${SVG_XML_URI})`);
  includes(svgXml, "<img", "svg+xml data URI should render as an <img>");
  includes(svgXml, SVG_XML_URI, "svg+xml data URI should be preserved verbatim");

  // Upstream's own svg (no +xml) still works…
  includes(r(`![v](${SVG_PLAIN_URI})`), "<img", "data:image/svg;base64 should still render");

  // …and we did not weaken the guard: a javascript: image is dropped.
  const evil = r("![x](javascript:alert(1))");
  assert(!evil.includes("<img"), "javascript: image must be stripped");

  console.log("ok smoke: SAFE_IMG allows svg+xml (patch 2), still blocks javascript:");
}

async function checkLensSeam() {
  const opened = await openRabbithole({ title: "Smoke Root", content: "# Smoke\n\nThe quick brown fox." });
  const session = getSession(opened.session_id);
  assert(session, "open_rabbithole should leave a live session");

  // Config lenses reached the page hydration (Warren patch 1: getLenses → hydration).
  const html = await (await fetch(session.url)).text();
  const hydration = parseHydration(html);
  assert(Array.isArray(hydration.lenses), "hydration should carry lenses");
  const steelman = hydration.lenses.find((l) => l.id === "steelman");
  assert(steelman, "hydration.lenses should include the config lens 'steelman'");
  assert.equal(steelman.label, "Steelman / Refute", "config lens label should survive to hydration");
  // Server-side #ask-lenses is empty; the client renders buttons from LENS_ORDER.
  includes(html, '<div class="ask-lenses" id="ask-lenses"></div>', "server should ship an empty lens bar");

  // A branch tagged with a config lens id must be accepted (normalizeLens) and
  // titled with the config label (lensLabel) — the server-side half of the seam.
  const requestId = "req-smoke";
  const nodeId = "node-smoke";
  const post = await postEvent(session, {
    type: "branch_request",
    request_id: requestId,
    node_id: nodeId,
    parent_id: session.rootId,
    selected_text: "quick brown fox",
    question: CONFIG_LENSES[0].q,
    lens: "steelman",
    anchor: { offset_start: 4, offset_end: 19 },
    branch_type: "selection",
    position: { x: 500, y: 0 },
    size: { w: 420, h: 460 },
  });
  assert.deepEqual(post, { ok: true, node_id: nodeId, request_id: requestId });

  const branch = await openRabbithole({ holeId: session.holeId });
  assert.equal(branch.status, "branch_request", "should receive the queued branch_request");
  assert.equal(branch.lens, "steelman", "config lens id must survive normalizeLens (not be nulled)");

  await answerBranch({ sessionId: session.id, requestId, content: "Steelman: ", partial: true });
  await answerBranch({ sessionId: session.id, requestId, content: "the counterargument, then rebutted." });

  // Persisted node is titled with the config lens LABEL, not the raw id/question.
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith(".json") && f !== "config.json");
  assert.equal(files.length, 1, `expected exactly 1 hole file, found ${files.length}`);
  const hole = JSON.parse(await fs.readFile(path.join(DIR, files[0]), "utf-8"));
  const child = hole.nodes.find((n) => n.id === nodeId);
  assert(child, "answered child should persist");
  assert.equal(child.status, "answered", "child should be answered");
  assert.equal(child.title, "Steelman / Refute", "node title should be the config lens label");
  assert.equal(child.origin.lens, "steelman", "origin.lens should carry the config lens id");
  includes(child.markdown, "rebutted", "answer markdown should persist");

  // listHoles must skip the coexisting config.json (Warren §B5 re-port).
  const listed = await listHoles();
  assert(listed.every((h) => typeof h.hole_id === "string"), "listHoles must not surface config.json as a hole");
  assert.equal(listed.length, 1, "listHoles should return exactly the one real hole");

  console.log("ok smoke: config lenses flow through hydration → normalizeLens → node title; listHoles skips config.json");
}

try {
  checkRenderer();
  await checkLensSeam();
  console.log("SMOKE OK");
} finally {
  await closeAllSessions("smoke_complete");
  await fs.rm(DIR, { recursive: true, force: true }).catch(() => {});
}

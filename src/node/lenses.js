import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUILTIN_LENSES } from "../core/model.js";
import { warn } from "./logger.js";

/**
 * Config-driven lenses (Warren patch 1 — node loader).
 *
 * The one-tap "lenses" in the ask popup are loaded from ~/.rabbithole/config.json
 * so they can be edited without touching code or rebuilding. This node-only
 * module is the config->server half of the seam: the session installs these into
 * the shared model (configureLenses) before reducing a branch request and ships
 * them in the page hydration, so the browser rebuilds its own LENSES to match.
 * The centralized lens state lives in src/core/model.js (browser-safe); only this
 * file reads the filesystem, keeping check:purity green.
 *
 * FAILS SOFT: a missing, unreadable, or invalid config yields the built-in four
 * plus a stderr warning — the server must always come up. Results are cached by
 * the config file's mtime, so editing config.json is picked up on the next hole
 * open with no server restart.
 *
 * A lens's `q` is the SHORT, human-readable question shown in the UI and sent to
 * the agent as the branch question. Full agent instructions live in the working
 * root's CLAUDE.md, keyed by the lens id (see origin.lens); keep `q` short here.
 */

const LENS_ID_RE = /^[A-Za-z0-9_-]+$/;

function configPath() {
  const dir = process.env.RABBITHOLE_DIR || path.join(os.homedir(), ".rabbithole");
  return path.join(dir, "config.json");
}

let cache = { mtimeMs: null, lenses: null };

function isValidLens(lens) {
  return (
    lens &&
    typeof lens.id === "string" &&
    LENS_ID_RE.test(lens.id) &&
    typeof lens.label === "string" &&
    lens.label.length > 0 &&
    typeof lens.q === "string" &&
    lens.q.length > 0
  );
}

/**
 * The active lenses: [{ id, label, q }]. Built-in four unless a valid config.json
 * overrides them. Cached by config mtime. Deduped by id (first definition wins).
 */
export function getLenses() {
  const p = configPath();
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    // No config file is the normal case — built-in behavior, no warning.
    return BUILTIN_LENSES;
  }
  if (cache.lenses && cache.mtimeMs === st.mtimeMs) return cache.lenses;

  let lenses = BUILTIN_LENSES;
  try {
    const json = JSON.parse(fs.readFileSync(p, "utf-8"));
    const list = json && Array.isArray(json.lenses) ? json.lenses : null;
    if (list && list.length) {
      const seen = new Set();
      const out = [];
      for (const lens of list) {
        if (!isValidLens(lens) || seen.has(lens.id)) continue;
        seen.add(lens.id);
        out.push({ id: lens.id, label: lens.label, q: lens.q });
      }
      if (out.length) lenses = out;
      else warn(`~/.rabbithole/config.json has no valid lenses; using built-in lenses`);
    }
  } catch (err) {
    warn(`~/.rabbithole/config.json unreadable; using built-in lenses: ${err.message}`);
  }
  cache = { mtimeMs: st.mtimeMs, lenses };
  return lenses;
}

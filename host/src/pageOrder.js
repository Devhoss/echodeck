/**
 * pageOrder.js — host/src/pageOrder.js
 *
 * Page reordering (final polish). Pure — imports nothing, so it stays testable
 * under plain `node --test` while `db.js` cannot be loaded there (better-sqlite3
 * is compiled against Electron's ABI). Same precedent as itemOrder.js.
 *
 * ── The visible/hidden split ────────────────────────────────────────────────
 * A `reorder_pages` batch describes the VISIBLE order only. Hidden pages (the
 * lazy "Unfiled" bucket, plan D3) are never offered as reorder targets, so they
 * are pinned to positions strictly after the last visible one, keeping their
 * existing relative order. That is what guarantees `pages[0]` is never a hidden
 * page — no matter what a client submits — and it is why a newly paired phone
 * cannot land on Unfiled (server.js sendState) and auto-switch cannot fall back
 * to it (performSwitch).
 *
 * `hidden` is read falsy-first, so it accepts raw SELECT rows (0/1 INTEGER) and
 * post-`toDeckPage` rows (boolean) alike.
 *
 * ── All-or-nothing ──────────────────────────────────────────────────────────
 * Like itemOrder.applyReorder: any violation rejects the whole batch and returns
 * `{ error }`, never a partial map. A client that submits a scrambled-but-
 * complete visible set gets exactly that order; one that misses or invents a
 * page gets nothing written.
 */

/**
 * existingPages = [{ id, hidden }] in current DB order; submittedIds = the full
 * visible id list in the wanted order. Returns { positions: Map<id, position> }
 * covering EVERY page (visible and hidden), or { error }.
 */
function applyPageOrder(existingPages, submittedIds) {
  if (!Array.isArray(existingPages)) {
    return { error: "existingPages must be an array of {id, hidden}" };
  }
  if (!Array.isArray(submittedIds)) {
    return { error: "submittedIds must be an array of page ids" };
  }

  const known = new Map(); // id -> hidden(boolean)
  for (const page of existingPages) {
    if (!page || typeof page.id !== "string") {
      return { error: "every existing page needs a string id" };
    }
    if (known.has(page.id)) {
      return { error: `duplicate page id "${page.id}" in the existing rows` };
    }
    known.set(page.id, !!page.hidden);
  }

  const visibleCount = [...known.values()].filter((hidden) => !hidden).length;

  const seen = new Set();
  for (const id of submittedIds) {
    if (typeof id !== "string") return { error: "submitted page ids must be strings" };
    if (!known.has(id)) return { error: `unknown page id "${id}"` };
    if (known.get(id)) {
      return { error: `hidden page "${id}" is not part of the visible order` };
    }
    if (seen.has(id)) return { error: `duplicate page id "${id}" in the submitted batch` };
    seen.add(id);
  }
  if (submittedIds.length !== visibleCount) {
    return {
      error: `submitted batch must cover every visible page (${submittedIds.length} submitted, ${visibleCount} visible)`,
    };
  }

  // Unique, known, non-hidden and exactly `visibleCount` long: a full
  // permutation of the visible set, so dense 0..n-1 is safe to write.
  const positions = new Map();
  submittedIds.forEach((id, i) => positions.set(id, i));
  let next = visibleCount;
  for (const page of existingPages) {
    if (page.hidden) positions.set(page.id, next++);
  }
  return { positions };
}

/** First row a client may legitimately land on. Null when none are visible. */
function firstVisiblePage(pages) {
  if (!Array.isArray(pages)) return null;
  return pages.find((p) => p && !p.hidden) ?? null;
}

module.exports = { applyPageOrder, firstVisiblePage };

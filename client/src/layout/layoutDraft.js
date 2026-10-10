/**
 * layoutDraft.js — client/src/layout/layoutDraft.js
 *
 * The mobile Edit Layout's in-memory draft model (Phase 4, Task 4.2). Pure:
 * no React, no DOM, no App.jsx import — only the shared TILE_SIZES enum, which
 * lives in the sibling deckLayout.js (itself pure) so this module stays
 * `node --test`-loadable. This is the canonical size list: TILE_SIZES is defined
 * once in deckLayout.js and mirrored by the host (host/src/widgets/widgetShape.js
 * WIDGET_SIZES / buttons size column) across the process boundary.
 *
 * ── Model ───────────────────────────────────────────────────────────────────
 * A `draft` is `{ items, byId, unfiledPageId }`:
 *   - items: one clone per deck tile, carrying its original fields (label,
 *     action_type, widget_type, source_id, … passthrough for the editor to
 *     render previews) plus normalized `key`, `kind`, `id`, `page_id`, `slot`,
 *     `size`.
 *   - byId: tile key -> the SAME object in `items` (so `draft.byId[key].size`
 *     reads the live value).
 *   - unfiledPageId: the hidden "Unfiled" page id once a detach has requested
 *     it (D3); undefined until then. Used by diffDraft to tell a detach from a
 *     plain cross-page move.
 *
 * ── Tile identity (READ THIS, Task 4.3) ─────────────────────────────────────
 * Buttons and widgets have independent numeric id sequences, so a bare number
 * can collide across kinds. Every operation's `id` / `activeId` / `overId`
 * argument is a composite tile KEY: `${kind}:${id}` (e.g. "button:7",
 * "widget:3"), which is also the natural dnd-kit sortable id. diffDraft always
 * converts back to bare `{ kind, id }` numbers for the host wire payload.
 *
 * ── Ordering (D2) ───────────────────────────────────────────────────────────
 * `slot` is authoritative; `position` is a legacy fallback. createDraft orders
 * each page by `(slot ?? position)` (stable — merge order breaks ties, buttons
 * ahead of widgets) and rewrites slots to a dense 0..n-1 within each page,
 * exactly what the host's applyReorder accepts (submitted slot VALUES are
 * authoritative and re-sorted).
 *
 * ── Purity ──────────────────────────────────────────────────────────────────
 * createDraft deep-clones the per-item fields it cares about; every operation
 * returns a NEW draft and NEVER mutates the base or an input draft. No-op
 * cases return the SAME draft reference (cheaply detectable), so callers can
 * skip state updates when a gesture produced no change.
 *
 * ── Operations ──────────────────────────────────────────────────────────────
 * reorder(draft, activeId, overId, kindOrder?)
 *   Same-page slot-dense reorder (arrayMove active -> over's slot). Cross-page
 *   (active and over on different pages) is a documented NO-OP: use moveToPage
 *   for cross-page. `kindOrder` (optional array of kind strings) is a secondary
 *   tie-break for equal-slot rows; draft slots are dense/unique so it normally
 *   does not fire — reserved for Task 4.3 flexibility. Unknown/absent ids and
 *   active === over are no-ops.
 * resize(draft, id, size)
 *   Sets a tile's size. `size` must be in TILE_SIZES or it is a NO-OP;
 *   resizing to the current size is a NO-OP.
 * moveToPage(draft, id, pageId)
 *   Cross-page move: appends the tile at the end of the target page and
 *   re-densifies slots on BOTH source and target. Same-page is a NO-OP.
 * detach(draft, id, requestUnfiledPage)
 *   "Remove from page without deleting" (D3). `requestUnfiledPage` is a REQUIRED
 *   3rd argument: a () => pageId callback the parent App uses to lazily create
 *   /reveal the hidden Unfiled page. It is invoked ONLY when a detach actually
 *   proceeds (the id exists) — never for resize/reorder/moveToPage, and never
 *   when detaching an unknown id, which is a NO-OP. The returned id is stored on
 *   the draft and becomes the tile's new page_id.
 *
 * ── diffDraft(base, draft) -> { reordersByPage, sizePatches, moves, detachments }
 * The four top-level keys are the plan's contract. Value shapes (picked here,
 * consumed by Task 4.3 / Save):
 *   reordersByPage: { [String(pageId)]: [{ kind, id, slot }, …] }
 *       Every AFFECTED page — its ordered {kind,id} membership in the draft
 *       differs from base (pure reorder, gained/lost a tile via moveToPage or
 *       detach, or BOTH in one session) — gets its FULL dense 0..n-1 order
 *       batch; untouched pages emit nothing. The host applies moves and
 *       detachments first (re-parenting tiles), then each per-page batch;
 *       because a batch equals the draft's final dense order it covers exactly
 *       the post-move membership of that page, satisfying the host's
 *       all-or-nothing applyReorder (complete-permutation) rule. A page with
 *       no items left in the draft emits nothing (the moves fully describe it).
 *   sizePatches:    [{ kind, id, size }, …]  one per tile whose size changed.
 *   moves:          [{ kind, id, fromPage, toPage, toSlot }, …]
 *       Cross-page moves; excludes detaches. `toSlot` is the tile's dense slot
 *       on the target page in the draft (end of the list for a plain move).
 *   detachments:    [{ kind, id, fromPage, toPage, toSlot }, …]
 *       Tiles now on the Unfiled page (draft.unfiledPageId) that were not there
 *       in base. Empty when no detach happened (unfiledPageId is undefined).
 */

import { TILE_SIZES } from "./deckLayout.js";

const tileKey = (kind, id) => `${kind}:${id}`;
const bySlot = (a, b) => a.slot - b.slot;

function makeDraft(items, unfiledPageId) {
  const byId = {};
  for (const it of items) byId[it.key] = it;
  return { items, byId, unfiledPageId };
}

// Rebuild an ordered page list (slot order) after editing raw item objects.
function pageOf(draft, pageId) {
  return draft.items.filter((it) => it.page_id === pageId).sort(bySlot);
}

// dnd-kit / default arrayMove semantics: remove `from`, insert at `to`.
function arrayMove(list, from, to) {
  const out = list.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}

export function createDraft(deckItems) {
  // Clone each row's own fields (never keep references to caller rows) and
  // stash the pre-densify ordering key so pages can be re-ordered independently.
  const seeded = deckItems.map((it, index) => ({
    ...it,
    key: tileKey(it.kind, it.id),
    kind: it.kind,
    id: it.id,
    page_id: it.page_id,
    size: it.size,
    slot: it.slot ?? it.position ?? null,
    _order: it.slot ?? it.position ?? Number.MAX_SAFE_INTEGER,
    _index: index,
  }));

  const byPage = new Map();
  for (const it of seeded) {
    if (!byPage.has(it.page_id)) byPage.set(it.page_id, []);
    byPage.get(it.page_id).push(it);
  }

  const items = [];
  for (const group of byPage.values()) {
    group.sort((a, b) => a._order - b._order || a._index - b._index);
    group.forEach((it, i) => {
      it.slot = i;
      delete it._order;
      delete it._index;
      items.push(it);
    });
  }
  return makeDraft(items, undefined);
}

export function resize(draft, id, size) {
  const cur = draft.byId[id];
  if (!cur) return draft; // unknown tile
  if (!TILE_SIZES.includes(size)) return draft; // invalid size = no-op
  if (cur.size === size) return draft; // idempotent
  const items = draft.items.map((it) => (it.key === id ? { ...it, size } : it));
  return makeDraft(items, draft.unfiledPageId);
}

export function reorder(draft, activeId, overId, kindOrder) {
  if (activeId === overId) return draft;
  const active = draft.byId[activeId];
  const over = draft.byId[overId];
  if (!active || !over) return draft;
  if (active.page_id !== over.page_id) return draft; // cross-page = no-op

  const page = active.page_id;
  const list = pageOf(draft, page);
  const cmp = (a, b) => {
    if (a.slot !== b.slot) return a.slot - b.slot;
    if (Array.isArray(kindOrder) && a.kind !== b.kind) {
      return kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind);
    }
    return 0;
  };
  list.sort(cmp);
  const from = list.findIndex((it) => it.key === activeId);
  const to = list.findIndex((it) => it.key === overId);
  if (from < 0 || to < 0) return draft;

  const moved = arrayMove(list, from, to);
  const slotOf = new Map();
  moved.forEach((it, i) => slotOf.set(it.key, i));
  const items = draft.items.map((it) =>
    it.page_id === page ? { ...it, slot: slotOf.get(it.key) } : it,
  );
  return makeDraft(items, draft.unfiledPageId);
}

export function moveToPage(draft, id, pageId) {
  const cur = draft.byId[id];
  if (!cur) return draft;
  if (cur.page_id === pageId) return draft; // same-page = no-op

  const fromPage = cur.page_id;
  const moved = { ...cur, page_id: pageId };
  const sourceList = pageOf(draft, fromPage).filter((it) => it.key !== id);
  const targetList = pageOf(draft, pageId);
  const newTarget = [...targetList, moved]; // append at the end of the target

  const patch = new Map();
  sourceList.forEach((it, i) => patch.set(it.key, i));
  newTarget.forEach((it, i) => patch.set(it.key, i));

  const items = draft.items.map((it) => {
    if (it.key === id) return { ...moved, slot: patch.get(id) };
    if (patch.has(it.key)) return { ...it, slot: patch.get(it.key) };
    return it;
  });
  return makeDraft(items, draft.unfiledPageId);
}

export function detach(draft, id, requestUnfiledPage) {
  const cur = draft.byId[id];
  if (!cur) return draft; // nothing to detach -> do not request the page
  if (typeof requestUnfiledPage !== "function") {
    throw new TypeError("detach(draft, id, requestUnfiledPage) requires a callback");
  }
  const unfiledPageId = requestUnfiledPage(); // lazy: only now
  const next = moveToPage(draft, id, unfiledPageId);
  return { ...next, unfiledPageId };
}

export function diffDraft(base, draft) {
  const unfiled = draft.unfiledPageId;
  const sizePatches = [];
  const moves = [];
  const detachments = [];

  // The draft re-parents tiles but never adds or removes them, so base and
  // draft share an identical key set — every comparison is a per-key delta.
  for (const cur of draft.items) {
    const was = base.byId[cur.key];
    if (!was) continue; // defensive; shouldn't happen
    if (was.size !== cur.size) {
      sizePatches.push({ kind: cur.kind, id: cur.id, size: cur.size });
    }
    if (was.page_id !== cur.page_id) {
      const entry = {
        kind: cur.kind,
        id: cur.id,
        fromPage: was.page_id,
        toPage: cur.page_id,
        toSlot: cur.slot,
      };
      if (unfiled !== undefined && cur.page_id === unfiled) {
        detachments.push(entry);
      } else {
        moves.push(entry);
      }
    }
  }

  const reordersByPage = {};
  const pages = new Set([
    ...base.items.map((it) => it.page_id),
    ...draft.items.map((it) => it.page_id),
  ]);
  for (const page of pages) {
    const draftPage = pageOf(draft, page);
    if (draftPage.length === 0) continue; // emptied by moves/detaches: no order to pin
    const basePage = pageOf(base, page);
    // Affected = the draft's ordered {kind,id} membership differs from base's:
    // order changed, membership changed (move/detach on or off), or both. Emit
    // the draft's full dense batch so a reorder+move session round-trips fully.
    const affected =
      basePage.length !== draftPage.length ||
      basePage.some((it, i) => it.key !== draftPage[i].key);
    if (affected) {
      reordersByPage[String(page)] = draftPage.map((it, i) => ({
        kind: it.kind,
        id: it.id,
        slot: i,
      }));
    }
  }

  return { reordersByPage, sizePatches, moves, detachments };
}

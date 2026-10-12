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
 * A `draft` is `{ items, byId, unfiledPageId, pageOrder, pageOrderClaim }`:
 *   - items: one clone per deck tile, carrying its original fields (label,
 *     action_type, widget_type, source_id, … passthrough for the editor to
 *     render previews) plus normalized `key`, `kind`, `id`, `page_id`, `slot`,
 *     `size`.
 *   - byId: tile key -> the SAME object in `items` (so `draft.byId[key].size`
 *     reads the live value).
 *   - unfiledPageId: the hidden "Unfiled" page id once a detach has requested
 *     it (D3); undefined until then. Used by diffDraft to tell a detach from a
 *     plain cross-page move.
 *   - pageOrder: the VISIBLE page ids in the wanted order (final polish: page
 *     reordering is draft-scoped). Seeded by createDraft from the caller's
 *     visibleDeckPages(pages); only shiftPage changes it and item ops carry it
 *     forward, so a hidden page can never enter it.
 *   - pageOrderClaim: boolean — this draft holds a page order a local tap
 *     authored and the host has not yet confirmed. No claim: the draft has no
 *     opinion and FOLLOWS the host (followHostPageOrder). Outstanding claim:
 *     frames only heal the set (reconcilePageOrder), so a refused retry stays
 *     committable. The claim closes when a frame's order confirms it.
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
 * shiftPage(draft, pageId, delta)
 *   Page reordering (final polish). Moves one VISIBLE page ±1 place in
 *   `draft.pageOrder` — a list the draft receives from the caller
 *   (visibleDeckPages(pages)) and never derives from item rows, so a hidden page
 *   cannot sneak into a reorder batch. Item ops leave it untouched. A move that
 *   actually happens AUTHORS `pageOrderClaim: true` (this draft now has an
 *   order opinion the host has not confirmed); the same-reference no-ops
 *   author nothing.
 *
 * ── diffDraft(base, draft) -> { reordersByPage, sizePatches, moves, detachments, pageOrder }
 * The top-level keys are the plan's contract. Value shapes (picked here,
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
 *   pageOrder:      string[] — the new visible id order when it changed, []
 *       otherwise.
 */

import { TILE_SIZES } from "./deckLayout.js";

const tileKey = (kind, id) => `${kind}:${id}`;
const bySlot = (a, b) => a.slot - b.slot;

function makeDraft(items, unfiledPageId, pageOrder, pageOrderClaim = false) {
  const byId = {};
  for (const it of items) byId[it.key] = it;
  return {
    items,
    byId,
    unfiledPageId,
    pageOrder: normalizeOrder(pageOrder),
    pageOrderClaim: pageOrderClaim === true,
  };
}

// Visible page ids, de-duped, strings only. Order is the caller's business: it
// comes from visibleDeckPages(pages) at draft-entry and only shiftPage changes
// it, so a hidden page (the lazy Unfiled bucket) can never enter it.
function normalizeOrder(pageOrder) {
  if (!Array.isArray(pageOrder)) return [];
  const seen = new Set();
  const out = [];
  for (const id of pageOrder) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
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

export function createDraft(deckItems, pageOrder = [], pageOrderClaim = false) {
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
  return makeDraft(items, undefined, pageOrder, pageOrderClaim);
}

export function resize(draft, id, size) {
  const cur = draft.byId[id];
  if (!cur) return draft; // unknown tile
  if (!TILE_SIZES.includes(size)) return draft; // invalid size = no-op
  if (cur.size === size) return draft; // idempotent
  const items = draft.items.map((it) => (it.key === id ? { ...it, size } : it));
  return makeDraft(items, draft.unfiledPageId, draft.pageOrder, draft.pageOrderClaim);
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
  return makeDraft(items, draft.unfiledPageId, draft.pageOrder, draft.pageOrderClaim);
}

/**
 * Page reordering: shift one VISIBLE page by `delta` (±1) within the draft's
 * page order. This is the touch-safe alternative to dragging — the phone offers
 * Move earlier / Move later — and it changes nothing about the items, so it
 * composes freely with reorder/moveToPage/detach in one session. Unknown ids
 * and moves past either end are no-ops returning the SAME draft, so a disabled
 * button firing anyway cannot dirty the toolbar. A move that happens authors
 * the page-order CLAIM: this draft now has an order the host has not confirmed,
 * which is the only thing that may make a Save re-commit it.
 */
export function shiftPage(draft, pageId, delta) {
  const order = draft.pageOrder;
  const from = order.indexOf(pageId);
  if (from < 0) return draft;
  const to = from + (Number.isInteger(delta) ? delta : 0);
  if (to < 0 || to >= order.length) return draft;
  if (to === from) return draft; // delta 0 authored nothing
  return makeDraft(draft.items, draft.unfiledPageId, arrayMove(order, from, to), true);
}

/**
 * Page reordering: heal a draft's page ORDER against the host's authoritative
 * visible ids — prune pages the host no longer shows, append pages created since
 * the draft was seeded. Never re-sorts: a surviving id keeps its slot, so an
 * unsaved claim is never clobbered. Same reference when the sets already match
 * and the claim does not flip. A stale id left in the order would poison the
 * whole batch (the host's `reorder_pages` is all-or-nothing), and a page missing
 * from it would render a toolbar row whose Earlier/Later buttons do nothing.
 */
export function reconcilePageOrder(draft, visibleIds) {
  const order = draft.pageOrder;
  const host = visibleIds ?? [];
  const hostSet = new Set(host);
  const orderSet = new Set(order);
  const next = [
    ...order.filter((id) => hostSet.has(id)),
    ...host.filter((id) => !orderSet.has(id)),
  ];
  // The host agreeing closes the claim; anything else leaves it standing so Save
  // can re-commit a batch the host refused.
  const claim = next.every((id, i) => id === host[i]) ? false : draft.pageOrderClaim;
  if (
    next.length === order.length &&
    next.every((id, i) => id === order[i]) &&
    claim === draft.pageOrderClaim
  ) {
    return draft;
  }
  return makeDraft(draft.items, draft.unfiledPageId, next, claim);
}

/**
 * Page reordering: mirror the host's visible order into a draft that authored no
 * claim of its own. A phone sitting in Edit Layout without having touched the
 * Pages rows has no opinion about order, so another client's reorder must land as
 * the draft's order — otherwise the dots show an order the host already replaced
 * and Save can re-assert it. Same reference when the sequences already match.
 */
export function followHostPageOrder(draft, hostIds) {
  const order = draft.pageOrder;
  const host = hostIds ?? [];
  if (
    order.length === host.length &&
    order.every((id, i) => id === host[i]) &&
    !draft.pageOrderClaim
  ) {
    return draft;
  }
  return makeDraft(draft.items, draft.unfiledPageId, host, false);
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
  return makeDraft(items, draft.unfiledPageId, draft.pageOrder, draft.pageOrderClaim);
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

  // Page order is a separate, independent axis from item order: it reports when
  // the two visible lists differ at the same length. A length mismatch means the
  // caller mixed drafts from different sessions and the host would reject a
  // partial batch, so it reports nothing rather than a guaranteed rejection.
  const wasOrder = base.pageOrder ?? [];
  const nowOrder = draft.pageOrder ?? [];
  const pageOrder =
    wasOrder.length === nowOrder.length &&
    wasOrder.length > 1 &&
    nowOrder.some((id, i) => id !== wasOrder[i])
      ? nowOrder
      : [];

  return { reordersByPage, sizePatches, moves, detachments, pageOrder };
}

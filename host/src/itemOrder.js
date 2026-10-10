/**
 * itemOrder.js — host/src/itemOrder.js
 *
 * Unified deck ordering (plan D2): both buttons and widgets carry a page-scoped
 * `slot` that interleaves the two kinds into one authoritative order, while the
 * legacy `position` becomes a server-derived dense rank within each kind so old
 * clients keep rendering correctly. Pure — imports nothing but built-ins, so it
 * stays testable under plain `node --test` (db.js loads better-sqlite3, which is
 * compiled against Electron's ABI; see widgetShape.js header for the precedent).
 *
 * Row-shape contract (pinned by test/itemOrder.test.js; consumed by Task 2.2):
 * existingRows / currentRows / targetPageRows are { buttons: [{id, ...}],
 * widgets: [{id, ...}] } — rows grouped by kind, only `id` (plus `slot`/
 * `position` for ordering) is read. backfillSlots takes the two row arrays
 * directly and reads {id, position, rowid?, page_id?}.
 *
 * `applyReorder` and `moveItemSlots` return `{ error: "<reason>" }` on invalid
 * input and never throw; success Maps are built in slot order, so iterating
 * them yields items top-to-bottom on the page. `backfillSlots` has no invalid
 * input to reject — it is called only from the migration's own SELECTs with
 * two well-formed row arrays — and always returns its rows array.
 */

const KINDS = ["buttons", "widgets"];

/**
 * Migration helper: assign slots that reproduce today's rendered order exactly,
 * so backfilling is visually a no-op. Per page (rows are grouped by page_id
 * when present; a single implicit page otherwise), buttons sorted by
 * (position, rowid) take slots 0..b-1, widgets sorted the same continue at
 * b..n-1. `position` is carried through unchanged — backfill adds slots, it
 * never rewrites legacy positions.
 */
function backfillSlots(buttonRows, widgetRows) {
  const rows = [
    ...KINDS.flatMap((kind, i) =>
      (i === 0 ? buttonRows : widgetRows).map((row) => ({ row, kind })),
    ),
  ];
  const pages = new Map(); // page_id -> { buttons: [], widgets: [] }
  rows.forEach(({ row, kind }, index) => {
    const key = row.page_id ?? "";
    if (!pages.has(key)) pages.set(key, { buttons: [], widgets: [] });
    pages.get(key)[kind].push({ row, index });
  });

  const out = [];
  for (const page of pages.values()) {
    let slot = 0;
    for (const kind of KINDS) {
      const sorted = page[kind].slice().sort(compareRows);
      for (const { row } of sorted) {
        out.push({
          table: kind === "buttons" ? "buttons" : "widgets",
          id: row.id,
          slot,
          position: row.position ?? 0,
        });
        slot += 1;
      }
    }
  }
  return out;
}

// (position, rowid) — the exact ORDER BY db.js uses today. Missing rowid falls
// back to the array index so the sort stays stable for in-memory fixtures.
function compareRows(a, b) {
  return (
    (a.row.position ?? 0) - (b.row.position ?? 0) ||
    (a.row.rowid ?? a.index) - (b.row.rowid ?? b.index)
  );
}

/**
 * Validate a full-page reorder batch and derive the new state.
 * submitted = [{kind,id,slot}]. All-or-nothing: every id must exist on the
 * page, the batch must cover every item exactly once, and slots must be a
 * permutation of 0..n-1 — anything else rejects the whole batch so the legacy
 * position derivation below can never see holes. On success, slot = submitted
 * slot (normalized to array index i in submitted order) and position = dense
 * rank of the item within its kind.
 */
function applyReorder(existingRows, submitted) {
  if (!isRowGroup(existingRows)) return { error: "existingRows must be { buttons: [...], widgets: [...] }" };
  if (!Array.isArray(submitted)) return { error: "submitted must be an array of {kind,id,slot}" };

  const existing = new Map(); // "kind:id" -> true
  const total = KINDS.reduce((n, kind) => {
    for (const row of existingRows[kind]) existing.set(`${kind}:${row.id}`, true);
    return n + existingRows[kind].length;
  }, 0);

  const seenIds = new Set();
  const seenSlots = new Set();
  for (const entry of submitted) {
    if (!entry || typeof entry !== "object") return { error: "each submission must be an object {kind,id,slot}" };
    const { kind, id, slot } = entry;
    if (!KINDS.includes(kind)) return { error: `unknown kind "${kind}"` };
    if (typeof id !== "string" && typeof id !== "number") return { error: "submission id must be a string or number" };
    if (!existing.has(`${kind}:${id}`)) return { error: `unknown item id "${id}" for kind "${kind}"` };
    const idKey = `${kind}:${id}`;
    if (seenIds.has(idKey)) return { error: `duplicate id "${id}" in submitted batch` };
    seenIds.add(idKey);
    if (!Number.isInteger(slot)) return { error: `slot for id "${id}" must be an integer` };
    if (slot < 0 || slot >= total) return { error: `slot ${slot} for id "${id}" is out of range 0..${total - 1}` };
    if (seenSlots.has(slot)) return { error: `duplicate slot ${slot} in submitted batch` };
    seenSlots.add(slot);
  }

  // Unique existing ids make over-submission impossible; under-submission
  // (holes) must still reject the whole batch.
  if (submitted.length !== total) {
    return { error: `submitted batch must cover every item on the page (${submitted.length} submitted, ${total} existing)` };
  }

  // Slots are a unique 0..n-1 set of n entries, hence a full permutation.
  // Normalize to the same values in submitted-slot order and derive dense
  // per-kind positions (D2) so legacy clients keep working.
  const ordered = submitted.slice().sort((a, b) => a.slot - b.slot);
  const slots = new Map();
  const positions = new Map();
  const rankByKind = { buttons: 0, widgets: 0 };
  ordered.forEach((entry, i) => {
    slots.set(entry.id, i);
    positions.set(entry.id, rankByKind[entry.kind]++);
  });
  return { slots, positions };
}

/**
 * Cross-page move helper (append-at-slot semantics used by the REST route).
 * Removes movedId from the current page, compacts the rest to 0..m-1, and
 * inserts it at targetSlot on the target page, shifting occupants from
 * targetSlot up by one. Returns two submitted lists — {source, target} — each
 * directly consumable by applyReorder against its page's rows. Rows are read
 * in slot order, falling back to legacy position when slot is absent.
 * Same-page move (movedId is already among the target rows) is a legitimate
 * single-list reorder: the moved id is excluded from the target slices before
 * insertion, so `target` holds every page item exactly once over 0..n-1; and
 * because source and target describe the SAME page, `source` is returned equal
 * to `target` (the post-move state) — a compacted source could never validate
 * against the page's n rows anyway.
 */
function moveItemSlots(currentRows, movedId, targetSlot, targetPageRows) {
  if (!isRowGroup(currentRows) || !isRowGroup(targetPageRows)) {
    return { error: "currentRows and targetPageRows must be { buttons: [...], widgets: [...] }" };
  }

  const kind = KINDS.find((k) => currentRows[k].some((row) => row.id === movedId));
  if (!kind) return { error: `moved id "${movedId}" not found on the current page` };

  const flatSource = flattenOrdered(currentRows);
  const fullFlatTarget = flattenOrdered(targetPageRows);
  // The moved id cannot be on two pages at once, so its presence in the
  // target rows identifies a same-page move.
  const samePage = fullFlatTarget.some((e) => e.id === movedId);
  const flatTarget = samePage
    ? fullFlatTarget.filter((e) => e.id !== movedId)
    : fullFlatTarget;
  if (!Number.isInteger(targetSlot) || targetSlot < 0 || targetSlot > flatTarget.length) {
    return { error: `target slot ${targetSlot} is out of range 0..${flatTarget.length}` };
  }

  const target = [
    ...flatTarget.slice(0, targetSlot).map((e, i) => ({ kind: e.kind, id: e.id, slot: i })),
    { kind, id: movedId, slot: targetSlot },
    ...flatTarget.slice(targetSlot).map((e, i) => ({ kind: e.kind, id: e.id, slot: targetSlot + i + 1 })),
  ];
  if (samePage) return { source: target, target };
  const source = flatSource
    .filter((e) => e.id !== movedId)
    .map((e, i) => ({ kind: e.kind, id: e.id, slot: i }));
  return { source, target };
}

// Page rows grouped by kind -> one [{kind,id,slot}] list in display order
// (slot first, legacy position as fallback, array order as tie-break).
function flattenOrdered(rowGroup) {
  const all = KINDS.flatMap((k) => rowGroup[k].map((row) => ({ ...row, kind: k })));
  return all
    .sort((a, b) => (a.slot ?? a.position ?? 0) - (b.slot ?? b.position ?? 0))
    .map(({ kind, id }) => ({ kind, id }));
}

function isRowGroup(value) {
  return (
    value &&
    typeof value === "object" &&
    Array.isArray(value.buttons) &&
    Array.isArray(value.widgets)
  );
}

module.exports = { backfillSlots, applyReorder, moveItemSlots };

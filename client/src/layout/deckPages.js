// D3: hidden pages (the lazy "Unfiled" bucket) are omitted from the visible
// deck navigation but stay reachable through the edit move sheet.
export function visibleDeckPages(pages) {
  return (pages ?? []).filter((p) => !p.hidden);
}

// Re-sort a page list by a draft's page order. Used to paint the pager dots in
// the order the user is building during Edit Layout, so a Move earlier / Move
// later tap is visible immediately without any host write. Ids the list does not
// have are dropped; pages the order does not mention trail, in their own order
// (a page created since the draft was seeded must still be reachable).
export function pagesInOrder(pages, order) {
  const list = pages ?? [];
  if (!Array.isArray(order) || order.length === 0) return list;
  const byId = new Map(list.map((p) => [p.id, p]));
  const out = [];
  for (const id of order) {
    const page = byId.get(id);
    if (!page) continue;
    out.push(page);
    byId.delete(id);
  }
  return [...out, ...byId.values()];
}

// Page reordering: the batch the phone should send, measured against the HOST's
// sequence rather than only the draft's baseline. Save is optimistic and the host
// answers a rejected `reorder_pages` with silence, so a baseline-only comparison
// strands an unaccepted order with Save disabled and no way to re-commit it.
// Returns the draft's whole order when it differs from the host's, else [] — a
// different LENGTH means the draft is stale (a page came or went) and the heal in
// reconcilePageOrder owns that case, so this stays [].
export function pageOrderBatch(draft, hostIds) {
  const order = draft?.pageOrder ?? [];
  const host = hostIds ?? [];
  if (order.length !== host.length) return [];
  return order.every((id, i) => id === host[i]) ? [] : order;
}

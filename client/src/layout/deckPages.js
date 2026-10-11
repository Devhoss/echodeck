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

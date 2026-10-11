// D3: hidden pages (the lazy "Unfiled" bucket) are omitted from the visible
// deck navigation but stay reachable through the edit move sheet.
export function visibleDeckPages(pages) {
  return (pages ?? []).filter((p) => !p.hidden);
}

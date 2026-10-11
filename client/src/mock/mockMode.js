// Playwright viewport harness (Task 7.1) — the URL-flag detector shared by the
// mock socket and the measure instrument. Mirrors the existing `?desktop=1`
// idiom (App.jsx): the mock path is reachable ONLY through `?mock=1`, so the
// production bundle keeps byte-identical behavior when the flag is absent.
let cached = null;

export function isMockMode() {
  if (cached === null) {
    cached =
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("mock") === "1";
  }
  return cached;
}

/**
 * Count a grid measurement event for the spec's "widget_data tick must not
 * re-measure the grid" assertion. Inert unless `?mock=1` is on the URL —
 * production never touches `window`, never allocates the counter object.
 * kinds: "ro" (ResizeObserver callback fired) and "recompute" (the engine
 * actually ran computeDeckLayout because inputs changed).
 */
export function countDeckMeasure(kind) {
  if (!isMockMode()) return;
  const store = (window.__DECK_MEASURES__ ||= { ro: 0, recompute: 0 });
  store[kind] = (store[kind] || 0) + 1;
}

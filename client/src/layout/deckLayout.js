// Pure responsive deck-layout engine (Phase 1, Task 1.1). No React, no DOM:
// inputs are px + item sizes + settings, output is an explicit grid contract
// {cols, rows, cell, gap, placements, scrollY} that both renderers place with
// (D5). Deterministic fallbacks per D6: shrink span cols, never drop items;
// when height (not width) runs out, degrade to vertical scroll, never clip.
export const TILE_SIZES = ["1x1", "2x1", "1x2", "2x2"];
const SPANS = { "1x1": { cols: 1, rows: 1 }, "2x1": { cols: 2, rows: 1 },
                "1x2": { cols: 1, rows: 2 }, "2x2": { cols: 2, rows: 2 } };
export const PRESETS = {
  compact:  { minCell: 40, maxCell: 96,  gap: 6 },
  balanced: { minCell: 48, maxCell: 132, gap: 8 },
  large:    { minCell: 64, maxCell: 180, gap: 10 },
};
export const DEFAULT_SETTINGS = { mode: "auto", preset: "balanced",
  cols: null, minCell: null, maxCell: null, gap: null };

export function spanFor(size) { return SPANS[size] || SPANS["1x1"]; }
export function resolveBounds(s = {}) {
  const b = PRESETS[s.preset] || PRESETS.balanced;
  return { minCell: s.minCell ?? b.minCell, maxCell: s.maxCell ?? b.maxCell, gap: s.gap ?? b.gap };
}

// First-fit with column tie-break leftmost-highest. Dense enough for 1x1..2x2 spans.
// Items wider than the grid are clamped (span.clamped=true), never dropped (D6).
export function packGrid(items, cols) {
  const heights = new Array(cols).fill(0);
  const placements = [];
  items.forEach((it, index) => {
    const want = spanFor(it.size);
    const span = { cols: Math.min(want.cols, cols), rows: want.rows, clamped: want.cols > cols };
    let bestRow = Infinity, bestCol = 0;
    for (let c = 0; c <= cols - span.cols; c++) {
      let r = 0;
      for (let k = c; k < c + span.cols; k++) r = Math.max(r, heights[k]);
      if (r < bestRow) { bestRow = r; bestCol = c; }
    }
    placements.push({ index, col: bestCol, row: bestRow, span });
    for (let k = bestCol; k < bestCol + span.cols; k++) heights[k] = bestRow + span.rows;
  });
  return { rows: Math.max(1, ...heights), placements };
}

export function computeDeckLayout({ width, height, items, settings = DEFAULT_SETTINGS, maxCols = 12 }) {
  const { minCell, maxCell, gap } = resolveBounds(settings);
  // An empty page still needs sane sizing: pack one virtual 1x1 to drive the
  // score, then drop its placement (callers see zero placements for zero items).
  const list = items.length ? items : [{ size: "1x1" }];
  // Readable-column budget (D4): a column reserves 2*minCell + gap so the auto
  // mode never resolves "many thin unusable columns" on a phone and a preferred
  // cols ceiling lands on readable sizes (6 preferred at 320 px -> 3, per D4's
  // worked example).
  const widthCap = Math.max(1, Math.floor((width + gap) / (minCell * 2 + gap)));
  const cap = Math.min(maxCols, widthCap);
  const candidates = settings.mode === "custom" && settings.cols
    ? [Math.min(Math.max(1, settings.cols), cap)] : [];
  if (!candidates.length) for (let c = 1; c <= cap; c++) candidates.push(c);
  let best = null;
  for (const cols of candidates) {
    const packed = packGrid(list, cols);
    const cellW = (width - (cols - 1) * gap) / cols;
    const cellH = (height - (packed.rows - 1) * gap) / packed.rows;
    const cell = Math.floor(Math.min(cellW, cellH, maxCell));
    if (cell < minCell) continue;
    const fill = (cell * cols + (cols - 1) * gap) / width;
    const score = cell + fill * minCell + Math.min(1 / packed.rows, 1); // size first, then width use
    if (!best || score > best.score) best = { cols, rows: packed.rows, cell, gap, placements: packed.placements, fill, score, scrollY: false };
  }
  if (!best) { // narrower/taller than any fit: width-driven columns at minCell, vertical scroll
    const packed = packGrid(list, cap);
    const cellW = (width - (cap - 1) * gap) / cap;
    best = { cols: cap, rows: packed.rows, cell: Math.floor(Math.min(Math.max(cellW, minCell), maxCell)),
             gap, placements: packed.placements, scrollY: true };
  }
  // Contract: placements mirror items exactly (the empty-page placeholder stays internal).
  const placements = best.placements.slice(0, items.length);
  // Public output is exactly the grid contract; scoring internals (fill, score)
  // live only on the private candidate records above and never leave this function.
  return {
    cols: best.cols,
    rows: best.rows,
    cell: best.cell,
    gap: best.gap,
    placements,
    scrollY: best.scrollY,
  };
}

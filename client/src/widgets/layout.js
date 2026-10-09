/**
 * layout.js  —  client/src/widgets/layout.js
 *
 * How a tile occupies grid cells, and how many cells a page is worth.
 *
 * Buttons already support "1x1" and "2x2" via gridColumn/gridRow spans, but the
 * layout maths on both surfaces counted items rather than cells. A widget adds
 * "2x1" (a wide strip), which makes counting cells the only thing that works.
 */

// Grid cells each size occupies. Must stay in step with the host's WIDGET_SIZES
// and with the button span the renderers already apply for "2x2".
const CELLS = {
  "1x1": { cols: 1, rows: 1 },
  "2x1": { cols: 2, rows: 1 },
  "2x2": { cols: 2, rows: 2 },
};

export function cellsFor(size) {
  return CELLS[size] || CELLS["1x1"];
}

/** Total cells a list of tiles is worth. */
export function totalCells(items) {
  return items.reduce((sum, item) => sum + cellsFor(item.size).cols * cellsFor(item.size).rows, 0);
}

/**
 * Column count for a page.
 *
 * Mirrors the phone's existing heuristic (4 up to eight keys, 5 up to fifteen,
 * 7 beyond) but counts cells, so a page holding one 2x2 widget and three keys
 * does not get squeezed into a 4-column grid it cannot fill.
 */
export function columnsFor(items, cellCount = totalCells(items)) {
  const count = Math.max(cellCount, 1);
  if (count <= 8) return Math.min(4, count);
  if (count <= 15) return 5;
  return 7;
}

/**
 * Row count for a cell total at a given column count. Used by the phone's key
 * size measurement, which needs rows to work out the available height.
 */
export function rowsFor(count, cols) {
  if (cols <= 0) return 1;
  return Math.ceil(Math.max(count, 1) / cols);
}

/** Grid span style for a tile, matching what the button renderers already do. */
export function spanStyle(size) {
  const cells = cellsFor(size);
  if (cells.cols === 1 && cells.rows === 1) return {};
  return { gridColumn: `span ${cells.cols}`, gridRow: `span ${cells.rows}` };
}

# Layout Model Reference

The responsive deck grid is produced by a pure engine and consumed verbatim by
both renderers (phone and desktop). This document is the contract reference:
what the engine takes and returns, how it scores a grid, when it clamps or
scrolls, and how ordering (`slot`) and settings (`layout_config`, presets) are
derived and merged. It is a reference, not a tutorial — every claim cites the
code that implements it.

Primary files:

| Concern | File |
| --- | --- |
| Engine (pure, no DOM) | `client/src/layout/deckLayout.js` |
| Measurement hook | `client/src/layout/useDeckLayout.js` |
| Client settings merge | `client/src/layout/layoutSettings.js` |
| Edit-mode draft (mobile) | `client/src/layout/layoutDraft.js` |
| Preset form/snapshot rules | `client/src/layout/layoutForm.js` |
| Preset REST layer | `client/src/layout/presetsClient.js` |
| Host slot/position derivation | `host/src/itemOrder.js` |
| Host storage + migrations | `host/src/db.js` |
| Host validation | `host/src/layoutConfig.js` |
| Host API + WS | `host/src/server.js` |

## 1. Engine contract

`computeDeckLayout({ width, height, items, settings, maxCols })`
(`deckLayout.js:43-86`).

Inputs:

- `width`, `height` — CSS px of the deck container's **content box** (the hook
  subtracts padding before calling; `useDeckLayout.js:56-62`).
- `items` — the deck tiles in display order. The engine only reads
  `items[i].size`; sizes outside `"1x1" | "2x1" | "1x2" | "2x2"`
  (`TILE_SIZES`, `deckLayout.js:6-8`) fall back to a 1x1 span
  (`spanFor`, `deckLayout.js:17`).
- `settings` — defaults to `DEFAULT_SETTINGS`
  (`deckLayout.js:14-15`): `{ mode: "auto", preset: "balanced", cols: null,
  minCell: null, maxCell: null, gap: null }`. See section 2.
- `maxCols` — column ceiling, default `12` (`deckLayout.js:43`). The hook never
  passes it, so 12 is the effective ceiling on both surfaces.

Outputs — exactly six keys (`deckLayout.js:78-85`; the key set is pinned by
`client/test/deckLayout.test.js:180-188`):

- `cols`, `rows` — grid dimensions in cells. `rows >= 1` always
  (`deckLayout.js:40`).
- `cell` — integer px square cell size.
- `gap` — integer px gutter between cells.
- `placements` — one entry per input item, same length, same order
  (`deckLayout.js:74-75`). Each entry is
  `{ index, col, row, span: { cols, rows, clamped } }` with 0-based
  `col`/`row` (`deckLayout.js:25-41`).
- `scrollY` — `true` only in the height fallback (section 4); otherwise `false`.

Internal scoring values (`fill`, `score`) exist only on private candidate
records and never leave the function (`deckLayout.js:57-67`).

Rendering is deterministic (plan decision D5): tiles are placed from the
contract, not CSS auto-flow — `gridColumn: col+1 / span span.cols`,
`gridRow: row+1 / span span.rows` (`App.jsx:1867-1868`,
`DesktopApp.jsx:3860-3861`), and `scrollY` toggles the scroller
(`overflowY: auto`, `touchAction: pan-y` when true; `App.jsx:1840,1851`).

An empty page still gets sane sizing: one virtual 1x1 drives the score and its
placement is dropped, so `placements.length === 0` (`deckLayout.js:45-47,75`).

## 2. Bounds, presets-as-knobs, and mode

Three named engine presets supply cell-size bounds
(`PRESETS`, `deckLayout.js:9-13`):

| preset | minCell | maxCell | gap |
| --- | --- | --- | --- |
| `compact` | 40 | 96 | 6 |
| `balanced` | 48 | 132 | 8 |
| `large` | 64 | 180 | 10 |

`resolveBounds(settings)` layers explicit `minCell`/`maxCell`/`gap` values over
the bounds of `settings.preset` (an unknown preset name reads as `balanced`):
each explicit value wins per key, `null` defers to the preset
(`deckLayout.js:18-21`). This is why the settings UI has no fourth "custom"
preset in the engine — "custom" is simply explicit bounds over whatever preset
survives (`layoutForm.js:17-21`).

`settings.mode` gates column selection: candidates come from the auto scan
unless `mode === "custom"` **and** `cols` is truthy (`deckLayout.js:54-56`).

## 3. Column candidates and scoring

Auto mode scans every column count from 1 up to a cap and keeps the best score
(`deckLayout.js:56-67`). The cap is the smaller of `maxCols` (12) and a
readable-column budget:

```
widthCap = floor((width + gap) / (minCell * 2 + gap))     // deckLayout.js:52
cap      = min(maxCols, widthCap)                          // deckLayout.js:53
```

Each column reserves **2 × minCell** of width, so auto mode never resolves
"many thin unusable columns" on a phone (`deckLayout.js:48-52`). In custom mode
the single candidate is `clamp(settings.cols, 1, cap)`
(`deckLayout.js:54-55`): a preferred column count is a **ceiling, never a
floor** — `custom cols: 6` at 320 px resolves 3, at 1600 px resolves exactly 6
(verified output in section 9).

For each candidate (`deckLayout.js:58-66`):

1. Pack the items into `cols` columns with `packGrid` (section 4).
2. `cell = floor(min(cellW, cellH, maxCell))` where
   `cellW = (width - (cols-1)*gap) / cols` and
   `cellH = (height - (rows-1)*gap) / rows` — the cell is bounded by width,
   height, and the maxCell ceiling alike (`deckLayout.js:60-62`).
3. Reject the candidate if `cell < minCell` (`deckLayout.js:63`).
4. Score survivors: `score = cell + fill * minCell + min(1/rows, 1)`, where
   `fill = (cols used width) / width` (`deckLayout.js:64-65`). Cell size
   dominates; width usage contributes at most `minCell` more than one size
   step matters; fewer rows adds at most 1. Strict `>` comparison keeps the
   first best candidate, so on an exact tie the smaller column count wins.

The winner becomes `{ cols, rows, cell, gap, placements, scrollY: false }`.

## 4. Packing, clamp, and scroll fallbacks (D6)

`packGrid` (`deckLayout.js:25-41`) places items in input order, first-fit, with
a leftmost-highest tie-break over a per-column skyline. Determinism (same
inputs → byte-identical placements) is pinned by test
(`client/test/deckLayout.test.js:141-147`).

Two deterministic degradations, never item loss and never clipping:

**Span clamp (width).** An item wider than the grid has its `span.cols` shrunk
to `cols` and is marked `span.clamped = true`; nothing is dropped
(`deckLayout.js:29-30`). It only engages when the resolved grid narrows to one
column — via raised `minCell` (the clamp case below: `minCell: 160` makes
`widthCap = 1` at 320 px), a custom `cols: 1`, or an extreme viewport. Under
default settings 320 px resolves 2-3 readable columns, so even a lone `2x2`
fits unclamped (`client/test/deckLayout.test.js:115-127`). Real clamped
output: a lone `2x2` at `minCell: 160` is emitted as
`span: { cols: 1, rows: 2, clamped: true }` and still placed (section 9).

**Vertical scroll (height).** The fallback at `deckLayout.js:68-73` triggers
only when every candidate was rejected for `cell < minCell`. Because
`widthCap` guarantees `cellW >= 2·minCell` for any `cols <= cap`
(`deckLayout.js:52`), rejection can only come from `cellH` — i.e. the **height**
ran out, never the width. In that case the engine packs at `cap` (columns are
chosen from width alone), sets
`cell = floor(clamp(cellW, minCell, maxCell))` and `scrollY: true`; the renderer
then makes the deck vertically scrollable instead of clipping
(`App.jsx:1840,1851`). In custom mode the scroll fallback still packs at `cap`,
so a too-wide custom preference is overridden by the width-only cap when
height fails (`deckLayout.js:69-71`).

## 5. Measurement (`useDeckLayout`)

`useDeckLayout(containerRef, { items, settings })` returns the latest contract
or `null` before the first successful measure (`useDeckLayout.js:4,15`). It
measures the caller-owned container's content box (rect minus padding,
`useDeckLayout.js:55-62`), skips work when a composite key of
`width|height|sizes|settings` is unchanged (`useDeckLayout.js:20-21,63-64`) —
so live widget metric ticks never re-measure the grid — and keeps the previous
state object when the recomputed contract is value-identical
(`useDeckLayout.js:69-71`). The first measure runs synchronously inside
`useLayoutEffect` (`useDeckLayout.js:84-87`); later updates arrive from a
`ResizeObserver` on the element plus `resize` and `orientationchange` window
listeners, all coalesced to at most one recompute per animation frame
(`useDeckLayout.js:74-100`).

## 6. D2: `slot` is authoritative; `position` is derived

Buttons and widgets each carry a page-scoped `slot INTEGER` — one interleaved
order across both kinds — while the legacy `position` becomes a server-derived
dense rank **within each kind**, rewritten whenever slots change. Old clients
(APKs, older Electron) keep seeing exactly the old semantics: all buttons by
`position`, then all widgets.

- **Schema.** `slot` columns are added by a one-time migration that backfills
  the current rendered order: per page, buttons sorted by `(position, rowid)`
  take slots `0..b-1`, widgets sorted the same continue at `b..n-1`; legacy
  `position` values are left untouched (`itemOrder.js:26-64`,
  `db.js:180-215`).
- **Derivation rule.** A reorder submits `[{kind, id, slot}]` for the whole
  page. Validation is all-or-nothing: every id must exist on the page and the
  slots must be a permutation of `0..n-1` (`itemOrder.js:84-129`). On success
  `slot` = submitted slot and `position` = the item's dense rank within its
  kind, both written in one transaction (`itemOrder.js:117-128`,
  `db.js:791-806`) — no client can desync them.
- **Sanctioned writers.** WS `reorder_items` `{page_id, items:[{kind,id,slot}]}`
  (`server.js:1173-1189`); legacy WS `reorder_buttons`, folded into a full-page
  slot batch that preserves widget slots and lays the new button order back
  into the button-occupied slots (`server.js:534-587,1162-1170`); and
  `POST /api/items/move` for cross-page moves, which re-parents the row then
  applies both pages' reorders in one transaction (`server.js:589-630`,
  `itemOrder.js:131-175`, `db.js:808-834`). `slot` is in no PATCH whitelist —
  these writers derive it.
- **Append rule.** Newly created rows are stamped `slot = page's button count +
  widget count` (one SELECT), so they append at the tail of the merged order
  instead of interleaving mid-deck through the fallback (`db.js:767-785`,
  used by `createButton` `db.js:683` and `createWidget` `db.js:910`).
- **Read rule.** Page rows load `ORDER BY COALESCE(slot, position), rowid` —
  rows that predate slot adoption or were created outside the writers fall
  back to their legacy `position` (`db.js:619-628,752-764,866-873`).
- **Client merge.** Each surface builds one display list by stable-sorting
  `[...buttons, ...widgetsForPage]` on `(slot ?? position)`; ES stable sort
  breaks ties with merge order, so equal keys keep buttons ahead of widgets —
  the exact legacy rendering (`App.jsx:824-837`; desktop adds an optimistic
  slot overlay, `DesktopApp.jsx:395-413`). The mobile edit draft re-reads the
  same key and densifies each page to contiguous `0..n-1` slots, which is what
  `applyReorder` accepts back (`layoutDraft.js:30-35,111-143`); `diffDraft`
  emits full dense batches per affected page (`layoutDraft.js:218-273`).

## 7. D4: presets persist layout settings, not tile placements

Two distinct things are called "preset"; keep them apart:

- **Engine presets** (`compact`/`balanced`/`large`) are cell-size bound sets
  inside `settings.preset` (section 2).
- **Saved layout presets** (plan D4/D7) are rows in `layout_presets`
  (`db.js:134-143`) holding a named JSON snapshot
  `{ defaults?: {knobs}, pages?: { [pageId]: {knobs} } }` — the global
  `layout_config` scope and optional per-page scopes. `defaults`/`pages`
  values are exactly the six settings knobs of section 2, validated per scope
  by `sanitizePresetConfig` (`layoutConfig.js:83-112`).

A preset therefore saves **responsive behavior** — mode, engine preset, cols
ceiling, cell bounds, gap — **never placements**: no slots, no page membership,
no tile sizes. Placement already persists per page unconditionally, and copying
placements into a preset would bind it to one device's item set
(`layoutForm.js:8-14`).

Mechanics:

- **Save.** The settings form snapshots its pending diff into exactly one
  scope — global scope emits only the `defaults` diff, page scope only that
  page's full stored value — following the form's own scope toggle, never both
  (`layoutForm.js:146-221`).
- **Wire.** `GET/POST/DELETE /api/layout-presets`; there is no PUT — a preset
  is immutable, edit it by delete + recreate (`server.js:632-665`,
  `presetsClient.js:47-74`).
- **Apply.** One whole-replacement write per mentioned scope:
  `POST /api/settings {key:"layout_config"}` for `defaults`, `PATCH
  /api/pages/:id {layout_config}` for each page entry. Scopes the preset does
  not mention are left alone; apply fires **no** `reorder_items`, no
  `/api/items/move`, and no size PATCHes — placements are untouchable through
  presets (`App.jsx:1152-1210`; same rule on desktop, `DesktopApp.jsx:1237`).

## 8. Settings merge precedence

The real precedence chain the client renders with is
**defaults → global → page** (`layoutSettings.js:1-7`):

```
settings = { ...DEFAULT_SETTINGS, ...sanitize(globalLayout), ...sanitize(pageLayoutConfig) }
```

- `globalLayout` is the deck-wide `layout_config` stored in the `settings`
  key/value table and carried in the `state` payload / settings GET
  (`server.js:235-238,241-270`; fetched at `App.jsx:782-800`).
- The page scope is `pages.layout_config` (`db.js:237-242`), parsed to an
  object or `null` in page serialization (`server.js:1289-1293`).
- `mergeLayout` (`layoutSettings.js:43-49`) sanitizes each scope with the
  client mirror of the host rules: invalid or absent keys are dropped, which
  reads as "no opinion at this scope" and falls through to the next layer,
  finally `DEFAULT_SETTINGS` (`layoutSettings.js:24-36`). A `null`/absent
  global (unpaired, fetch pending) contributes nothing.
- Presets are **not** a fourth render-time layer. Applying one only rewrites
  the stored global/page scopes (section 7); from the next state frame the
  same three-layer merge reads the new values.
- Inside the engine, one more layering applies to the bounds specifically:
  explicit `minCell`/`maxCell`/`gap` in the merged settings override the bounds
  of the merged `preset` name via `resolveBounds` (`deckLayout.js:18-21`).

Storage-side nuances (they keep the merge honest):

- The host sanitizer **keeps explicit `null`s** as "clear this override"
  signals and rejects out-of-range `cols` (1..12) rather than clamping; the
  client mirror drops nulls instead, so cleared overrides resolve through the
  scopes above (`layoutConfig.js:37-56` vs `layoutSettings.js:24-36`).
- Host routes **replace** a scope wholesale; the settings UI therefore layers
  its diff over the scope's own stored config (`mergeScopeConfig`), never over
  merged display values, so saving one knob never freezes the other scopes'
  cascade (`layoutForm.js:129-141`; `server.js:252-256`, `db.js:443-477`).

## 9. Worked examples (real engine output)

Both examples use a 12-tile mixed fixture and `settings = DEFAULT_SETTINGS`
(engine preset `balanced`: `minCell 48`, `maxCell 132`, `gap 8`) with the
default `maxCols = 12`. The items, in display order after the D2 merge
(section 6): nine `1x1`, one `2x1` (index 3), one `1x2` (index 5), one `2x2`
(index 7).

Reproduce from `client/`:

```
node --input-type=module -e '
import { computeDeckLayout, DEFAULT_SETTINGS } from "./src/layout/deckLayout.js";
const items = [
  { size: "1x1" }, { size: "1x1" }, { size: "1x1" }, { size: "2x1" },
  { size: "1x1" }, { size: "1x2" }, { size: "1x1" }, { size: "2x2" },
  { size: "1x1" }, { size: "1x1" }, { size: "1x1" }, { size: "1x1" },
];
console.log(JSON.stringify(computeDeckLayout({ width: 320, height: 700, items, settings: DEFAULT_SETTINGS })));
console.log(JSON.stringify(computeDeckLayout({ width: 1600, height: 900, items, settings: DEFAULT_SETTINGS })));'
```

### 320 × 700 (phone portrait)

`widthCap = floor((320+8) / (2*48+8)) = 3`, so candidates are cols 1..3.
Col 1 is rejected (`cell = 42 < 48` — height-limited: 14 rows cannot fit);
col 2 scores 92.31 (`cell 70`); col 3 wins with 149.02. Verbatim output:

```json
{ "cols": 3, "rows": 6, "cell": 101, "gap": 8, "scrollY": false,
  "placements": [
    { "index": 0,  "col": 0, "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 1,  "col": 1, "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 2,  "col": 2, "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 3,  "col": 0, "row": 1, "span": { "cols": 2, "rows": 1, "clamped": false } },
    { "index": 4,  "col": 2, "row": 1, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 5,  "col": 0, "row": 2, "span": { "cols": 1, "rows": 2, "clamped": false } },
    { "index": 6,  "col": 1, "row": 2, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 7,  "col": 1, "row": 3, "span": { "cols": 2, "rows": 2, "clamped": false } },
    { "index": 8,  "col": 0, "row": 4, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 9,  "col": 0, "row": 5, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 10, "col": 1, "row": 5, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 11, "col": 2, "row": 5, "span": { "cols": 1, "rows": 1, "clamped": false } } ] }
```

`cell = 101`: width-limited (`cellW = (320 - 2*8) / 3 = 101.33`, floored),
under both `maxCell` and `cellH = (700 - 5*8) / 6 = 110`. Used width
`3*101 + 2*8 = 319 ≤ 320` — no overflow, no clamp (no span needed shrinking),
no scroll (`scrollY: false`).

### 1600 × 900 (desktop window)

`widthCap = floor((1600+8) / 104) = 15`, capped to `min(12, 15) = 12`. The
winner is **11 columns, not 12**: at 12 columns `cellW = (1600 - 11*8) / 12 =
126` (below `maxCell`), scoring `126 + 1.0*48 + 0.5 = 174.5`; at 11 columns
the cell hits the `maxCell` ceiling (`cellW = 138.2`, `cellH = 446`, so
`cell = 132`) and scoring `132 + 0.9575*48 + 0.5 = 178.46` — cell size
dominates, so paying ~68 px of unused width buys bigger tiles. Verbatim
output:

```json
{ "cols": 11, "rows": 2, "cell": 132, "gap": 8, "scrollY": false,
  "placements": [
    { "index": 0,  "col": 0,  "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 1,  "col": 1,  "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 2,  "col": 2,  "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 3,  "col": 3,  "row": 0, "span": { "cols": 2, "rows": 1, "clamped": false } },
    { "index": 4,  "col": 5,  "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 5,  "col": 6,  "row": 0, "span": { "cols": 1, "rows": 2, "clamped": false } },
    { "index": 6,  "col": 7,  "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 7,  "col": 8,  "row": 0, "span": { "cols": 2, "rows": 2, "clamped": false } },
    { "index": 8,  "col": 10, "row": 0, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 9,  "col": 0,  "row": 1, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 10, "col": 1,  "row": 1, "span": { "cols": 1, "rows": 1, "clamped": false } },
    { "index": 11, "col": 2,  "row": 1, "span": { "cols": 1, "rows": 1, "clamped": false } } ] }
```

Used width `11*132 + 10*8 = 1532 ≤ 1600`; every item placed, no clamp, no
scroll.

### Fallback cases (same command pattern, real output)

Scroll fallback — same fixture replaced by 24 `1x1` items at 800 × 100
(height far too small for any candidate): columns stay width-driven at
`cap = 7`, `scrollY` flips on:

```
{ cols: 7, rows: 4, cell: 107, gap: 8, placements: 24 entries, scrollY: true }
```

Clamp fallback — `{ ...DEFAULT_SETTINGS, minCell: 160, maxCell: 260 }`, one
`2x2` at 320 × 653: `widthCap = floor(328/328) = 1`, the span shrinks but the
item is still placed:

```
{ cols: 1, rows: 2, cell: 260, gap: 8, scrollY: false,
  placements: [ { index: 0, col: 0, row: 0,
                  span: { cols: 1, rows: 2, clamped: true } } ] }
```

Custom-cols ceiling — `{ ...DEFAULT_SETTINGS, mode: "custom", cols: 6 }` with
12 `1x1` items: at 320 px resolves `{ cols: 3, cell: 101 }` (ceiling honored
down to the readable cap), at 1600 px resolves `{ cols: 6, cell: 132 }`.

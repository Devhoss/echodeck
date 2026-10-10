# EchoDeck Responsive Layout & Mobile Customization Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace EchoDeck's rigid fixed-px square grid with a viewport-driven responsive layout engine, a unified button+widget placement model, a mobile Edit Layout mode, and a pull-down control sheet (issue #9) — working across phones, tablets, and desktop windows without device-specific code.

**Architecture:** One pure, unit-testable layout engine (`client/src/layout/deckLayout.js`) computes columns, cell size, and explicit item placements from the measured deck area plus user settings; both the phone (`App.jsx`) and desktop (`DesktopApp.jsx`) render that output into an explicitly-placed CSS grid. Order becomes a shared `slot` column on `buttons` and `widgets` (interleaved placement), persisted through new WS/REST messages handled by pure logic in `host/src/itemOrder.js`. The mobile header collapses to a tap+swipe control sheet; an Edit Layout mode reuses the existing @dnd-kit stack already powering desktop.

**Tech Stack:** React 19 (Vite), @dnd-kit (already a client dependency, `client/package.json:21-23`), Capacitor 6 Android, Electron host, Express + ws + better-sqlite3 (`host/src/`), `node --test` unit tests (client + host), Playwright (new devDependency) for the automated viewport matrix.

**Spec:** Owner brief of 2026-10-10, "EchoDeck — Responsive Layout and Mobile Customization Redesign" (sections cited as §n below), plus https://github.com/Devhoss/echodeck/issues/9.

## Global constraints

- No device-name detection, no Galaxy A11-specific dimensions. Layout derives from CSS viewport size, measured container box, and settings (§3).
- Existing action execution, hold-to-confirm (`App.jsx:74,1192,1232-1283`), volume hold-repeat (`App.jsx:574-589`, `host/src/server.js:729-734,893-946`), horizontal page swipe (`App.jsx:617-640`), pairing, and auto-profile rules must not regress.
- Live Widgets must keep full parity on mobile: source selection/persistence, SSH collection, `widget_data` WS frames, stale/offline states, Docker status, library drag (§8). No feature reduction on mobile.
- Migrations are backward-compatible and additive; existing button/page/profile/widget data must survive (§6). No unrelated DB redesigns.
- Every gesture needs a non-gesture equivalent (issue #9 accessibility requirement).
- Preserve the desktop editing workflow and action library; integrate shared placement without regressing it (§9).
- Avoid a pile of device-specific CSS overrides; prefer one coherent engine with shared math (§11).
- No metric-collection duplication; backend changes limited to layout/persistence proven necessary by the audit (§11).
- Test matrix uses CSS viewport widths around 320/360/390/430/600/768/1024/1280/1600 px in both orientations where meaningful (§10). These are test points, not breakpoints.
- Verification loop on every phase: `npm run lint` + `npm test` (client and host), `npm run build` (client); release phases run `.\build-android.ps1` + `adb install -r` and `npm run dist` (Electron), per issue #9's "APK rebuild is required, dist alone is not enough".

## Audit snapshot (verified 2026-10-10 — the facts this plan argues from)

- **Phone grid:** CSS grid with fixed px tracks `repeat(cols, keySize}px` / `gridAutoRows keySizepx`, gap 8, `placeContent:center` — `client/src/App.jsx:850-855`. `keySize` from the *shorter* axis, clamped 44–132 — `App.jsx:506-539`. Landscape wastes horizontal space because height binds first and nothing widens columns.
- **Column heuristic:** `columnsFor()` returns 4/5/7 by cell count — `client/src/widgets/layout.js:35-40`; cells map has only 1x1/2x1/2x2 — `layout.js:13-17`.
- **Buttons:** only `"2x2"` span is honored on phone (`App.jsx:1156-1157`) and desktop (`DesktopApp.jsx:3362-3364`); server creates buttons with hardcoded `size:"1x1"` (`host/src/server.js:424`). Button `size` is stored but unvalidated on PATCH (`host/src/db.js:604-626`).
- **Ordering:** buttons and widgets each carry a linear `position` (`db.js:43,100`), sorted `by position,rowid` (`db.js:548,668`), and both renderers force all buttons before all widgets: phone `App.jsx:859-891`, desktop `DesktopApp.jsx:1403-1448` (widgets deliberately outside the SortableContext, 1418-1422). Desktop reorder is `{v:1,t:"reorder_buttons",buttons:[{id,position}]}` over WS (`DesktopApp.jsx:1230-1242`, `server.js:965-968`).
- **Desktop grid:** same fixed-px pattern, auto-fit tries cols 1..8, clamps 48–104 px (`DesktopApp.jsx:338-393,1396-1401`). @dnd-kit `PointerSensor distance:6` (`DesktopApp.jsx:407-409`). No media queries/breakpoints anywhere in `DesktopApp.jsx`.
- **State flow:** phone is WS-only (`state`/`widget_data`/`update`/`stats`/`volume`/`play_sound`, `App.jsx:334-392`; `sendState` `server.js:1004-1053`); stats pushed every 3 s from the *local* host (`server.js:678-727`); remote Homelab numbers arrive only via widget `widget_data` frames. Pages/buttons live in SQLite at `~/AppData/Roaming/StreamDeck/macro-deck.db` (`db.js:13-19`).
- **Header (issue #9 target):** 44 px fixed bar + ~17 px dot row — `App.jsx:706-831,896-943`; contains icon/wordmark, CPU/RAM/clock pills (`App.jsx:741-762`), VolumePill (`765`), connection pill (`767-798`), disconnect (`800-830`).
- **Top edge is unclaimed:** deck swipe requires `|dx| ≥ 60 && |dx| ≥ 1.5·|dy|` (`App.jsx:632`) — predominantly vertical drags are already ignored, so a pull-down gesture has clean turf if it is claimed from the header strip and a thin top edge zone only.
- **Viewport handling:** `#root{height:100dvh}` (`index.css:129-133`); safe-area insets at `App.jsx:695-698,710-711,844-845`; `viewport-fit=cover` is misplaced outside the `content` attribute (`index.html:6`); Capacitor config says `StatusBar overlaysWebView:false` (`capacitor.config.json:13-17`) but `main.jsx:13` overrides it to `overlay:true` — must be unified.
- **Android orientation is locked:** `android:screenOrientation="sensorLandscape"` (`client/android/app/src/main/AndroidManifest.xml:28`). Portrait testing requires unlocking — **decision D1 below**.
- **Widget size whitelist:** `WIDGET_SIZES = ["1x1","2x1","2x2"]` (`host/src/widgets/widgetShape.js:50`); unknown size rejects the whole PATCH (147-148). Widget `page_id` is intentionally not PATCHable (`widgetShape.js:13-15,20`).
- **Migration style:** additive-only `pragma table_info` checks + `ALTER TABLE ADD COLUMN` (`db.js:131-182`); no versioned migration table. Field whitelists `PAGE_FIELDS` (`db.js:384`), `WIDGET_FIELDS`/`SOURCE_FIELDS` (`widgetShape.js:16-41`) gate any new column.
- **Tests:** `node --test` only, pure modules (no jsdom/RTL): `client/test/widgets.test.js`, `client/test/authArray.test.js`, `host/test/*.test.js`. Host tests deliberately avoid loading `better-sqlite3` (Electron ABI) — new host layout logic must live in a pure module to be testable.
- **CI:** single workflow `.github/workflows/android-release.yml` — `test` job on windows-latest runs host then client `npm test`; APK and EXE builds follow on tag.

---

# Decisions taken in this plan (with rationale and trade-offs)

**D1 — Unlock Android orientation.** Portrait support is required by §3/§10, so `sensorLandscape` must go. Change to `fullSensor`; the layout engine then handles both axes. Trade-off: users who relied on forced landscape get rotation; mitigate with the OS rotation lock (Android respects it when the user pins it). If the owner rejects rotation unlocking, portrait work still lands for desktop-window and tablet-portrait cases but real-phone portrait testing stays out of scope — flag at Phase 4 start.

**D2 — `slot` is the authoritative interleaved order; `position` stays as a derived legacy column.** A brand-new `slot INTEGER` on `buttons` and `widgets` gives one order across both kinds per page. `position` is kept (never removed) and rewritten as the dense rank *within* each kind whenever slots change, so old clients (installed APKs / older Electron) keep seeing exactly today's semantics: buttons-sorted-by-position first, widgets after. Trade-off: mild redundancy between `slot` and `position`, but it is server-written and server-derived — no client can desync them. Deleting `position` instead would break mixed-version fleets for no gain (§6: "avoid storing redundant state" targets *computed layout output*, which we never store).

**D3 — Detach-to-"Unfiled" page for "remove from page without deleting".** Buttons and widgets require a page (`page_id NOT NULL`). Rather than a nullable column + special-casing every query, Edit Layout's "Remove from page" moves the item to a lazily-created page named `Unfiled` flagged `hidden=1`. Hidden pages are omitted from the phone pager and desktop PageRail but browsable from the Edit toolbar's move sheet. Trade-off: old paired apps will briefly show the Unfiled dot if a user hides items before upgrading the APK; documented, acceptable within one release train.

**D4 — Layout settings resolve in three scopes; placement is per page.**
- *Global default* (`settings.layout_config`): mode/preset/gap/min-max cell for pages without their own choice. Cheap: reuses the existing `settings` key/value + whitelist (`server.js:216-238`).
- *Per page* (`pages.layout_config` JSON column, new): the same knobs plus nothing else. Chosen because "how this profile uses my screen" is page-specific (a 3-key page vs a 24-key page).
- *Presets* (new `layout_presets` table): **named snapshots of settings only** (mode, preset, bounds, per-page knob overrides map), not physical placements. Placement already persists per page unconditionally — copying placements into presets would couple a preset to one device's item set and break §6's "preset should retain its intent across devices". Save/apply a preset = read/write settings.
- Manual-vs-small-screen rule (§3 question): a user's `cols` preference is a *ceiling*, never a floor. Effective columns = `min(preferredCols, widthMaxCols)` where `widthMaxCols = floor((width+gap)/(minCell+gap))`. A 6-column preference on a 320 px screen resolves to 3 readable columns; nothing unreadable is ever forced.

**D5 — Engine returns explicit placements; the grid renders them.** No reliance on CSS auto-flow: the engine computes `{cols, cell, gap, rows, placements[]}` and every tile is placed with `gridColumn: c+1 / span s.cols`, `gridRow: r+1 / span s.rows`. Deterministic across platforms, and unit tests can assert exact (row, col) output. `placeContent:center` is removed; the engine already consumes width.

**D6 — Spans: add `1x2`; keep 1x1/2x1/2x2; stop there.** §5's "additional spans only if real value": `1x2` covers the tall tile; wider/taller spans (3x1, 2x3, 4x2) multiply packing edge cases with no demand. Widget minimum legibility is a *creation-time* concern (default size stays 2x2, metric count seeds a suggested size), not a runtime clamp — the engine only ever *shrinks* spans to fit the column count (deterministic fallback per §5: reduce span cols, never drop items; nothing is hidden, reflow adds rows).

**D7 — Mobile editing keeps @dnd-kit, not the desktop's click-drawer.** `SortableContext` + `PointerSensor(activation distance 10)` + `DragOverlay` in a mode that (a) suppresses press/hold execution and (b) commits through a draft/diff, not per-pixel PATCHes. Desktop's `distance:6` sensor stays untouched.

**D8 — Edit-mode persistence is draft-then-commit.** All edits accumulate in a local draft; "Save" flushes `reorder_items` + size PATCHes + page moves in one batch; "Discard" throws the draft away and re-reads server state. This is what makes cancel/discard honest (§4) and keeps interrupted drags harmless (dnd-kit reverts visually; nothing was persisted).

---

# Phase 1 — Audit and responsive layout architecture

Deliverable: the pure layout engine + measurement hook, proven by unit tests across the viewport matrix. Nothing rendered yet.

### Task 1.1 — `deckLayout.js`: spans, packing, and the compute function

**Files:**
- Create: `client/src/layout/deckLayout.js`
- Test: `client/test/deckLayout.test.js` (runs under existing `npm test` = `node --test`)

**Interfaces (produces — later tasks depend on exactly these names):**
- `TILE_SIZES: string[]` → `["1x1","2x1","1x2","2x2"]`
- `spanFor(size: string): {cols,rows}` (unknown size → `{cols:1,rows:1}`)
- `PRESETS: {compact|balanced|large}` with `{minCell,maxCell,gap}`
- `DEFAULT_SETTINGS = {mode:"auto", preset:"balanced", cols:null, minCell:null, maxCell:null, gap:null}`
- `resolveBounds(settings) -> {minCell,maxCell,gap}`
- `packGrid(items: {size}[], cols) -> {rows, placements: [{index, col, row, span:{cols,rows,clamped}}]}`
- `computeDeckLayout({width, height, items, settings, maxCols=12}) -> {cols, rows, cell, gap, placements, scrollY}`

- [ ] **Step 1: Write the failing tests** (full matrix, not samples). The viewport table below is the single source of test points §10 asks for; every later task reuses it via a shared `client/test/viewports.js` helper file:

```js
// client/test/viewports.js
// width x height CSS px. Phone portrait/landscape, foldable, tablet, desktop.
export const VIEWPORTS = [
  { name: "narrow-phone-portrait",   w: 320,  h: 653 },
  { name: "phone-portrait",          w: 360,  h: 800 },
  { name: "phone-portrait-large",    w: 390,  h: 844 },
  { name: "phone-portrait-xl",       w: 430,  h: 932 },
  { name: "compact-phone-landscape", w: 653,  h: 320 },
  { name: "phone-landscape",         w: 800,  h: 360 },
  { name: "phone-landscape-large",   w: 932,  h: 430 },
  { name: "foldable-expanded",       w: 673,  h: 841 },
  { name: "tablet-portrait",         w: 800,  h: 1280 },
  { name: "tablet-landscape",        w: 1024, h: 768 },
  { name: "small-tablet-portrait",   w: 600,  h: 960 },
  { name: "desktop-compact",         w: 900,  h: 600 },  // Electron minHeight/width pair
  { name: "desktop-window",          w: 1280, h: 800 },
  { name: "desktop-wide",            w: 1600, h: 900 },
];
```

Core assertions in `deckLayout.test.js` (each is a `node:test` case iterating all 14 viewports):
1. **No horizontal overflow:** `cols*cell + (cols-1)*gap <= width + 1` for every viewport × item-set fixture (fixtures: 0, 1, 3, 6, 12, 16, 24 buttons; plus 12 buttons + 1 widget 2x2; plus mixed 2x1/1x2 spans).
2. **Cell within bounds:** `cell >= minCell && cell <= maxCell` whenever `scrollY === false`.
3. **All items placed and in-grid:** `placements.length === items.length`, every `col+span.cols <= cols`, `row+span.rows <= rows`.
4. **Landscape fills width:** for `phone-landscape` (800×360) with 12 buttons, used width ≥ 90% of `width` (this is the regression this redesign exists for — today's build leaves ~40% empty).
5. **Span clamp fallback:** item `2x2` at `width=320` yields `span.clamped===true`, `span.cols===1`, item still placed, nothing dropped.
6. **Preferred-cols ceiling:** `settings {mode:"custom", cols:6}` on width 320 resolves `cols<=3` (per D4), and on width 1600 resolves exactly 6.
7. **Determinism:** same inputs → byte-identical `placements` (guards §5's "deterministic fallback").
8. **Height overflow degrades to scroll, not clip:** a fixture whose `rows*minCell` exceeds height returns `scrollY===true` with `cols` chosen from width only.

Run: `cd client && npm test` — expect FAIL (module missing).

- [ ] **Step 2: Implement the engine.** Sketched and reasoning-checked; the implementer lands exactly this shape:

```js
// client/src/layout/deckLayout.js
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
  const list = items.length ? items : [{ size: "1x1" }];
  const widthCap = Math.max(1, Math.floor((width + gap) / (minCell + gap)));
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
  return best;
}
```

Behavior beyond the tested points, for §12's "smaller and larger than the test viewports": **narrower** than one `minCell` → 1 column, `minCell` floor, `scrollY` if rows overflow height. **Taller** (portrait phablet) → more cell px up to `maxCell`, never more columns than width allows. **Wider** than `maxCols·maxCell` (4K desktop) → columns capped at 12 and cell at preset max; remaining space is symmetric padding (`justifyContent:center` replaces `placeContent`). Aspect-ratio is not special-cased anywhere — the binding constraint is simply which axis runs out of `minCell` budget first.

- [ ] **Step 3: Run tests to green** — `cd client && npm test`, expect PASS.
- [ ] **Step 4: Commit** — `git add client/src/layout/deckLayout.js client/test/deckLayout.test.js client/test/viewports.js && git commit -m "feat(client): responsive deck layout engine"`

### Task 1.2 — `useDeckLayout.js`: measurement hook

**Files:**
- Create: `client/src/layout/useDeckLayout.js`
- Modify: none yet (consumers land in Phase 3)

**Interfaces — Produces:**
`useDeckLayout(containerRef, { items, settings }) -> { layout, ref }` where `layout` is `computeDeckLayout` output or `null` before first measure. Internally: `useLayoutEffect` + `ResizeObserver` + `window resize` + `orientationchange` (the exact belt-and-suspenders set proven necessary in `App.jsx:527-533`), measuring the container's **content box** (the padding trap documented at `App.jsx:511-513`), debounced with `requestAnimationFrame` coalescing (pattern already used at `widgets/panelHelpers.js:31-55`). Recalculation is keyed on `width/height/items.length/settings` — **not** on metric data — so live widget updates never re-trigger layout (§11).

- [ ] Steps: unit-test the pure helper `measureContentBox(el)` extraction by moving it into `deckLayout.js` as `contentBox(width,padX)` math or skip tests for the hook (no DOM env exists — cover in Playwright at Phase 7); implement; `npm test` + `npm run lint` green; commit.

---

# Phase 2 — Layout data model and backward-compatible persistence

Deliverable: `slot`, `layout_config`, presets, and item-move plumbing on the host, with pure modules under test. No UI depends on it yet.

### Task 2.1 — `host/src/itemOrder.js`: pure slot logic

**Files:**
- Create: `host/src/itemOrder.js`
- Test: `host/test/itemOrder.test.js` (must not import `better-sqlite3` — host test constraint, `widgetShape.js:7-10` docblock)

**Interfaces — Produces (db.js will consume):**
- `backfillSlots(buttonRows, widgetRows) -> [{table:"buttons"|"widgets", id, slot, position}]` — per page, buttons first in `(position,rowid)` order taking slots `0..b-1`, widgets continuing `b..n-1`. **This reproduces exactly today's rendered order, so migration is visually a no-op** (§6 backward compatibility).
- `applyReorder(existingRows, submitted) -> {slots: Map<id, number>, positions: Map<id, number>} | {error}` — `submitted = [{kind,id,slot}]`; validates every id exists on the target page and every slot is a unique integer `0..n-1` (reject the whole batch otherwise — all-or-nothing keeps legacy `position` derivation consistent); then sets `slot = i` by submitted order and `position` = dense rank within kind (D2).
- `moveItemSlots(currentRows, movedId, targetSlot, targetPageRows) -> submitted` helper for cross-page moves (append-at-slot semantics used by the REST route).

Test code must cover: backfill order parity (fixture: buttons positions [2,0,1], widgets [0,1] → merged slot order is buttons sorted then widgets), reject-on-duplicate-slot, reject-on-foreign-id, position-derivation after reorder (submit interleaved b0,w0,b1 → positions b:0,1 w:0), cross-page append.

- [ ] Steps: write failing tests → implement → `cd host && npm test` PASS → commit `feat(host): pure item order (slot) module`.

### Task 2.2 — Schema migration + API surface (db.js / server.js / widgetShape.js)

**Files:**
- Modify: `host/src/db.js` (additive column migration pattern at 131-162; sort change at `getButtons:546-551`, `getWidgets:666-671`; new `updateItemLayout` + `moveItem` statements; `PAGE_FIELDS:384`)
- Modify: `host/src/server.js` (WS handler ~958-968; new REST routes under the auth gate, i.e. below `app.use("/api"...)` at 110-117)
- Modify: `host/src/widgets/widgetShape.js` (`WIDGET_SIZES:50` → `["1x1","2x1","1x2","2x2"]`; keep `page_id` out of PATCH — moves go through the dedicated route per D3's reasoning that silent page moves were forbidden deliberately)
- Modify: `host/src/db.js` `buttons.size` — server creates with `size:"1x1"` (`server.js:424`) unchanged; PATCH already passes any string; validation of button size against `TILE_SIZES` is added here (mirror list in `db.js` as `BUTTON_SIZES = ["1x1","2x1","1x2","2x2"]`; an unknown size on PATCH is dropped with 400 rather than stored, matching widget behavior `widgetShape.js:146-148`).
- Schema additions (follow existing `CREATE TABLE IF NOT EXISTS` + pragma-check style):

```sql
ALTER TABLE pages ADD COLUMN layout_config TEXT DEFAULT NULL;   -- JSON knobs per D4
ALTER TABLE pages ADD COLUMN hidden INTEGER DEFAULT 0;          -- Unfiled page (D3)
ALTER TABLE buttons ADD COLUMN slot INTEGER;
ALTER TABLE widgets ADD COLUMN slot INTEGER;
CREATE TABLE IF NOT EXISTS layout_presets (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  config TEXT NOT NULL,          -- {defaults:{...}, pages:{[pageId]:{...}}}
  created_at TEXT);
```

Backfill runs once per column-add branch (same place as `show_labels` backfill at `db.js:175-182`) via `itemOrder.backfillSlots`.
- `PAGE_FIELDS` gains `layout_config` (normalized through a `sanitizeLayoutConfig` mirroring `buildWidgetUpdate`'s drop-don't-default philosophy: unknown keys stripped, `cols` clamped 1..12, mode/preset enum-checked).
- settings whitelist (`server.js:233-238`) gains `layout_config` (global default).
- New WS inbound: `{v:1,t:"reorder_items",page_id,items:[{kind,id,slot}]}` → `itemOrder.applyReorder` → transactional write → `sendState` broadcast to the page's sockets. Keep `reorder_buttons` handler (`server.js:965-968`) working unchanged for old desktops; internally it runs through the same slot writer (buttons-only interleaving is a subset).
- New REST: `POST /api/items/move {kind,id,page_id,slot}` (cross-page move incl. widgets — the sanctioned page_id write), `PATCH /api/pages/:id {layout_config}` via existing route (`server.js:364`), `GET/POST/DELETE /api/layout-presets`, `GET/POST /api/settings` reuse.
- `toDeckButton`/widget serialization in `sendState` (`server.js:1018-1052`) gain `slot`; page objects gain `layout_config` and `hidden` (parsed to boolean like `show_labels` at `server.js:1059-1061`).

- [ ] **Steps:** failing host tests for `sanitizeLayoutConfig` and the size whitelist (pure — put both next to their module, they must not require the DB); implement migration + routes; manual smoke: start host (`cd host && npm run dev`), open `GET /api/pages`, confirm slots/positions coexist and order matches the old client view; commit `feat(host): slot column, per-page layout config, presets, item moves`.

**Acceptance for Phase 2:** host tests green; old client (`echodeck-local.apk` on hand) behaves 100% identically against the new host (it ignores `slot`); new order survives host restart (SQLite check via `node -e` one-liner reading the DB file).

---

# Phase 3 — Responsive grid + mixed button/widget placement in both renderers

Deliverable: phone and desktop decks render engine output with interleaved order. This is the first user-visible phase.

### Task 3.1 — Phone deck renders `computeDeckLayout`

**Files:**
- Modify: `client/src/App.jsx` (replace `layout` useMemo 495-501 and keySize effect 506-539 with `useDeckLayout`; replace grid style 850-855; replace `layout.js`'s `columnsFor` usage; render loop 859-891)
- Modify: `client/src/widgets/layout.js` (re-export spans from the engine; delete `columnsFor/rowsFor` phone heuristic once App.jsx stops calling it; keep `totalCells` if still referenced by DesktopApp until 3.2)

Placement model on the client: merge `buttons` + `widgetsForPage` and sort by `slot` (fallback `position` when `slot` is null, e.g. talking to an older host):

```js
const deckItems = useMemo(() => {
  const merged = [...buttons.map((b) => ({ ...b, kind: "button" })),
                  ...widgetsForPage.map((w) => ({ ...w, kind: "widget" }))];
  return merged.sort((a, b) => (a.slot ?? a.position) - (b.slot ?? b.position));
}, [buttons, widgetsForPage]);
```

Grid render becomes explicit placement (D5): `gridTemplateColumns: repeat(${layout.cols}, ${layout.cell}px)`, `gridAutoRows: ${layout.cell}px`, `gap: layout.gap`, each child `style.gridColumn = p.col + 1 / span p.span.cols`, `gridRow` likewise; the two map blocks (859-875 buttons, 878-891 widgets) collapse into one `deckItems.map` switching on `kind`. `overflow:"hidden"` (843) becomes `overflowY: layout.scrollY ? "auto" : "hidden"` with `touchAction` switching `"none"→"pan-y"` **only when `scrollY`** — and when scrollY, the page-swipe thresholds stay safe because they read pointer deltas, not scroll; note: with `pan-y` the browser may cancel pointer sequences on vertical scroll, which today already happens harmlessly (the swipe requires `|dx|≥1.5|dy|`, `App.jsx:632`).
Button spans: honor `layout.placements[].span` for buttons instead of the 2x2-only special case at `App.jsx:1156-1157` (the wrapper div carries the span, tile inner no longer needs `span 2` logic).
Layout settings resolution: `settings = mergeLayout(DEFAULT_LAYOUT, globalLayoutConfig, currentPageObj.layout_config)` — small helper `client/src/layout/layoutSettings.js` (pure, one unit test).

- [ ] **Steps:** 1) snapshot-check that no engine call remains behind: after wiring, `npm run build` + open dev server, rotate emulator/DevTools responsive mode — grid recomputes with no stale frames (the `useLayoutEffect` requirement at `App.jsx:503-505` is inherited by `useDeckLayout`); 2) unit-test `layoutSettings.js` merge precedence (global < page < custom overrides); 3) lint/test/build green; 4) commit `feat(client): phone deck uses responsive engine with interleaved slots`.

### Task 3.2 — Desktop deck renders the same engine + widget reorderability

**Files:**
- Modify: `client/src/desktop/DesktopApp.jsx` (measure loop 338-393 and grid style 1396-1401 → `useDeckLayout`; render blocks 1403-1450 → one `deckItems` merge sorted by slot; include widgets inside `SortableContext` with a unified `items=[{id,kind}]`; on drag end emit slot-dense order for the *merged* list and send `reorder_items` (debounce 300 ms — copy the pattern at 1230-1242); drop `reorder_buttons` send (receiver stays for old clients); button size segment 4140-4156 gains 2x1/1x2 options from `TILE_SIZES`; AddSlot stays last, out of slot space (it is not a deck item).

Desktop keeps @dnd-kit PointerSensor `distance:6` (`DesktopApp.jsx:407-409`) and `rectSortingStrategy`; the collision hybrid (417-422) must extend `closestCenter` to widget ids now that widgets sort. The `widget:` drop path (1215-1220) is unaffected.

- [ ] **Steps:** implement; manual smoke in Electron dev (`cd host && npm run dev` + start Electron, or `?desktop=1` in a browser per `App.jsx:642-673`): drag a widget between buttons, resize the window — columns/cell follow the engine, order persists across restart (SQLite `slot`); lint/test/build; commit `feat(desktop): unified slot ordering on the responsive grid`.

**Acceptance for Phase 3:** mixed order renders identically on phone and desktop (same slot data); landscape 800×360 fixture fills ≥90% width (engine test 4) *and* is visually confirmed in Playwright (Phase 7 formalizes; do a quick manual DevTools check now); no item ever disappears/clips horizontally at any listed viewport (manual spot of 320 and 1600).

---

# Phase 4 — Mobile Edit Layout mode and touch interaction

Deliverable: §4's editable deck on the phone, draft-committed, gesture-conflict-free.

### Task 4.1 — Manifest unlock + orientation-safe plumbing (D1)

**Files:**
- Modify: `client/android/app/src/main/AndroidManifest.xml:28` `sensorLandscape` → `fullSensor`
- Modify: `client/capacitor.config.json:13-17` `overlaysWebView:false` → `true` (stop contradicting `main.jsx:13`); verify `env(safe-area-inset-*)` paddings at `App.jsx:695-698,710-711,844-845` still hold; re-enable the bottom inset commented out at `App.jsx:696` for the sheet's close affordance.
- Modify: `client/index.html:6` — move `viewport-fit=cover` **into** the content attribute string.

- [ ] Steps: apply; `build-android.ps1`; `adb install -r echodeck-*.apk`; rotate device both ways through settings-lock and unlocked; commit `feat(android): allow portrait and unify edge-to-edge status bar`.

### Task 4.2 — Edit mode state machine + deck draft

**Files:**
- Create: `client/src/layout/layoutDraft.js` — pure: `createDraft(deckItems)`, `reorder(draft, activeId, overId, kind-order)`, `resize(draft, id, size)`, `moveToPage(draft, id, pageId)`, `detach(draft, id)` (targets the Unfiled page lazily via `requestUnfiledPage()` callback injected by App.jsx), `diffDraft(base, draft) -> {reordersByPage, sizePatches, moves, detachments}`.
- Test: `client/test/layoutDraft.test.js` — diff correctness (touching one tile of 20 produces exactly 1 sizePatch and only affected-page reorder), interrupted-drag revert = empty diff, discard leaves base untouched.
- Modify: `client/src/App.jsx` — new `editMode` state; in edit mode `SortableButton` receives `editable` and suppresses `onPress`, hold-confirm timer start (guard at `App.jsx:1241-1251`), and volume hold start (1254-1259) — the *only* pointer behavior left on a tile is drag/select.

- [ ] Steps: TDD the draft module; wire; commit `feat(client): deck layout draft model`.

### Task 4.3 — Edit UI: dnd-kit surface, drop previews, resize, page moves, detach

**Files:**
- Create: `client/src/mobile/DeckEditorBar.jsx` — bottom overlay bar in edit mode: [Done] [Save] + per-item toolbar shown for the selected tile: size segments (`TILE_SIZES`, disabled where the engine reports the span would clamp to 1 col at the current width), [Move to page ▸] (opens a small page list including Unfiled), [Remove from page] (detaches, never deletes).
- Modify: `client/src/App.jsx` — wrap the deck in `DndContext`+`SortableContext` when `editMode` (imports already used by `DesktopApp.jsx:24-41`; the `useSortable` wrapper for phone tiles reuses `SortableButton` with a `dragHandleProps`-spread root, `CSS.Transform` via `utilities` — same recipe as `DesktopApp.jsx:3323-3343`). Sensor: `PointerSensor` `activationConstraint.distance:10`. `onDragOver` → engine reruns the *draft* item list so the live preview shows the exact target cells (drop preview requirement, §4); `onDragEnd` → `reorder()` into draft; `onDragCancel` → no-op (nothing was written — D8 makes recovery free). Long-press (500 ms, `onPointerDown` timer cleared on move>10px) on a tile also *enters* edit mode + selects it, but is explicitly not the only door: the entry control lives in the control sheet (Task 5.3) and as a persistent ✏️ chip in the collapsed handle's expanded tap area.
- Visual states: edit mode adds a dashed tile outline + reduced saturation on non-selected tiles; the DragOverlay ghost mirrors `DesktopApp.jsx:1456-1474`.

- [ ] **Steps:** implement; on-device checks (Galaxy A11 + one portrait device/emulator): drag across pages' worth of items, flip to a page mid-draft (pages switch locally, draft keyed by page — moving a tile to another page via toolbar works while on either page), Save → confirm via `GET /api/pages` slots updated and old desktop still shows sane order; Discard → deck snaps back with zero network writes beyond nothing (verify host log/WS frames); interrupted drags (lift finger at viewport edge) revert; lint/test/build; commit `feat(client): mobile edit layout mode with drag, resize, and draft persistence`.

**Risks (Phase 4):** dnd-kit inside a `touch-action:none` container already owned by the swipe handler — resolved by disabling the deck-level swipe listeners while `editMode` (page changes move to the pager dots + rail, both already tap-friendly, `App.jsx:912`). `sensorLandscape→fullSensor` changes muscle memory for rotation lock users (accepted, D1).

---

# Phase 5 — Pull-down control sheet (issue #9)

Deliverable: 44 px header + stat pills replaced by a ~28 px status handle with a real, tap-openable control sheet.

### Task 5.1 — `StatusHandle` (collapsed state)

**Files:**
- Create: `client/src/mobile/StatusHandle.jsx`
- Modify: `client/src/App.jsx:706-831` (header block replaced)

Spec: 28 px tall (plus `env(safe-area-inset-top)`), a single 44-px-high tap target spanning the strip (accessibility: whole handle is a `<button aria-expanded aria-controls="deck-control-sheet">`). Contents at rest: EchoDeck icon, connection dot only (color reflects `status` — reusing 767-798 logic), a hairline "pull" chevron that is **hidden at rest and fades in during a downward gesture** (owner's reveal-on-intent rule: reserve its space so nothing reflows). No CPU/RAM/volume numbers permanently on screen — that is the space issue #9 asked to reclaim. Mic state, when active, may pin a small icon (it currently has no header pill anyway, per `App.jsx:1180-1187`).

- [ ] Steps: build component; commit with 5.2 after wiring.

### Task 5.2 — `ControlSheet` (expanded state)

**Files:**
- Create: `client/src/mobile/ControlSheet.jsx`
- Modify: `client/src/App.jsx` (stats state 369-377 already supplies everything; VolumePill logic `App.jsx:1055-1112` is extracted — not duplicated — into the sheet, upgraded to: slider tap + minus/plus buttons + mute toggle; **hold-to-repeat reuses the existing client messages** `volume_hold_start/stop` via `startVolumeHold/stopVolumeHold` (`App.jsx:574-589`) so repeat semantics are identical to tile volume keys; disconnect button relocated verbatim from `App.jsx:800-830` incl. confirm modal 945-1026)

Sheet content order: caption **"EchoDeck host — this computer"** above CPU/RAM/time pills (local stats per §7; explicitly *not* labeled Homelab — remote numbers live only in widget tiles, already source-labeled via `WidgetTile.jsx:36-58`), volume+mic, connection status, Disconnect, **Edit Layout** entry, and a compact Settings link opening layout prefs (Phase 6). Mechanics: push-down (not overlay) — sheet occupies the outer flex column above the deck (`App.jsx:694` stack), so deck area shrinks and `useDeckLayout` recomputes on the ResizeObserver (§3 requirement 6); no internal scroll (content is fixed-height, fits landscape because sheet max-height is `min(55%, 220px)` with content in a 2-column flow below 500 px width — a layout constraint, not a device rule). Close: chevron/up-swipe on sheet/Esc/focus-loss on outside tap; `role="dialog"` + focus trap + `aria-modal="false"` (it pushes, doesn't block, the deck).

- [ ] Steps: implement; animate open/close with translate+height in a `prefers-reduced-motion` guard (pattern `index.css:183-192`); verify deck never lands in a half-resized state after close (engine gets final box via RO; the `useLayoutEffect` ordering handles the pre-paint frame).

### Task 5.3 — Gesture arbitration

**Files:**
- Modify: `client/src/App.jsx` (swipe handlers 617-640; new top-edge listeners)

Rules, each with a test or manual step:
1. Tap/click/Enter/Space on handle → toggle sheet (non-gesture equivalent, required by #9).
2. Pull-down: pointerdown whose `clientY < safeTop + 28px` **or** on the handle, then `dy ≥ 24 && dy > 1.5·|dx|` → open. Implemented on the outer column with a capture-phase pointerdown that records origin and a pointermove that only claims the sequence when the origin test passes — tile sequences are excluded by origin (tiles never sit in the top strip: handle occupies it; in-sheet drags start below it).
3. Page swipe: unchanged; its horizontal-dominance test (`App.jsx:632`) and the sheet's vertical-dominance test are complementary by construction — document the invariant in code with a one-line comment.
4. Hold-to-confirm / volume hold on tiles: untouched; sheet claims nothing from the deck body (origin rule), and edit-mode drag lives only in edit mode where executes are suppressed anyway.
5. `setPointerCapture` inside guarded tiles (`App.jsx:1236`) retargets *that* sequence — the top-edge origin filter never matches a tile pointerdown (origin is below the strip), so no interaction.

- [ ] Steps: implement; **device matrix run** (A11 landscape + one portrait): open via tap, via pull, via keyboard on desktop (`?desktop=1` — handle hidden there; sheet stays mobile-only, desktop keeps ProfileMenu — §9 desktop preservation), close via each affordance; rapid open/close while swiping pages — no stuck state; commit `feat(client): pull-down control sheet (closes #9)`.

**Acceptance for Phase 5:** header vertical cost drops 44→~28+inset; every relocated control reachable by touch and keyboard; #9's body checklist verifiably satisfied.

---

# Phase 6 — Layout presets and customization settings

Deliverable: §3 "Layout settings" + §6 presets UI on top of Phase 2 storage.

### Task 6.1 — Layout settings sheet

**Files:**
- Create: `client/src/layout/LayoutSettingsForm.jsx` (shared by mobile sheet + desktop dialog; pure form over the `layout_config` shape)
- Modify: `client/src/mobile/ControlSheet.jsx` (Settings ▸ section), `client/src/desktop/DesktopApp.jsx` (ProfileMenu dropdown 2684-2877 gains "Layout settings…"), `App.jsx`/`DesktopApp.jsx` settings resolution to feed `mergeLayout` results into the engine.

Controls: mode (Automatic | Custom columns), preset (Compact/Balanced/Large/Custom), custom sliders (gap, min/max cell — revealed only in Custom), per-page vs deck-wide ("Apply to this page" toggle; default writes the global), orientation note: **no orientation-specific storage in v1** — the engine reacts to the live box, and storing per-orientation intents was rejected as redundant state (§6 "avoid storing redundant layout state"); revisit only if the owner reports a real need. Manual-vs-small-screen behavior (D4 ceiling) is surfaced as helper text: "Preferred columns are a maximum; narrower screens use fewer."

- [ ] Steps: implement; PATCH smoke (`PATCH /api/pages/:id` with `layout_config`, confirm `sanitizeLayoutConfig` strips junk keys); commit.

### Task 6.2 — Presets: save / apply / delete

**Files:**
- Create: `client/src/layout/presetsClient.js` (fetch/save helpers over `GET/POST/DELETE /api/layout-presets`)
- Modify: `LayoutSettingsForm.jsx` (Save as preset… / Apply preset picker / Delete), host (routes exist from Phase 2).

Preset semantics per D4: named settings snapshots (global defaults + per-page knob overrides), device-agnostic; applying never touches slots, so no placement data moves.

- [ ] Steps: implement; restart the app → saved page settings reload from `state` frame (`pages` carry `layout_config`); commit `feat(client): layout settings and presets`.

---

# Phase 7 — Cross-viewport and real-device verification

Deliverable: the §10 matrix with an honest split between automated and physical proof.

### Task 7.1 — Playwright viewport harness (automated)

**Files:**
- Modify: `client/package.json` — devDependency `playwright`, script `"test:viewport": "playwright test client/test/viewport"` (kept out of `npm test` so the Node-runner suite stays dependency-light for CI and non-networked runs)
- Create: `client/test/viewport/harness.html` + `harness.jsx` — mounts the real `App.jsx` deck grid components (`SortableButton`, `WidgetTile`, `SystemMonitorWidget`) against a stubbed `ReconnectingWebSocket` fed canned `state`/`widget_data`/`update` frames from fixture JSON. This proves renderer-level behavior, not just engine math.
- Create: `client/test/viewport/deck.spec.ts` — loops `VIEWPORTS` (imported from the same `client/test/viewports.js`) asserting per point: `document.documentElement.scrollWidth === clientWidth` (no horizontal overflow), every `data-deck-item` id present and fully inside the grid box, tile computed size within `[minCell,maxCell]` of the active settings, `widget_data` tick does **not** trigger a grid re-measure (spy on RO callback count), sheet: tap-handle opens, drag opens, Esc closes, at each viewport, edit mode: tap select → resize → save diff POSTs (via mocked WS frame capture).

- [ ] Steps: scaffold; run `npm run build` first, serve `dist` + `?mock=1` (add a tiny mock-socket gate at `App.jsx` connect site 292-295 behind `import.meta.env.VITE_MOCK` or a URL flag — URL flag preferred so production bundle stays honest); iterate to green; commit `test(client): playwright viewport matrix harness`.

### Task 7.2 — CI wiring

**Files:**
- Modify: `.github/workflows/android-release.yml` — new `viewport` job (windows-latest, same as existing `test` job precedent `ecf33c6`) after `test`: `npx playwright install chromium && npm run test:viewport` in client.

- [ ] Steps: wire; verify on a branch push (workflow currently triggers on tags only — add `workflow_dispatch` + `push` paths filter for the test job so PRs run it).

### Task 7.3 — Physical verification (manual, scripted checklist)

- [ ] Galaxy A11 APK: `powershell .\build-android.ps1` then `adb install -r` — matrix: landscape with 12-key page (width-fill check), portrait (after D1), sheet pull/tap/close during incoming-call-style interruption (`pause`/`resume` — WS watchdog at `App.jsx:405-433` reconnects and layout re-measures), repeated page switching with/without widgets ×20 (stability §10), SSH host online → offline (cable pull) → online: stale/offline badges in tiles, sheet state, and layout never reflow away the offline widget.
- [ ] One tablet-class device or emulator AVD at `800x1280` portrait (create via Android Studio AVD; **do not** buy device time for each §10 point — Playwright covers CSS pixels; physical only for touch/WebView truth).
- [ ] Electron `npm run dist`, install, run: window resize 900×600 ↔ maximized while deck open (engine re-measure, no clipping at `minWidth:900` `main.js:94-110`), desktop editor regression pass (drag from library, drawer save, reorder persistence), restart app → all saved layouts/slots intact in `~/AppData/Roaming/StreamDeck/macro-deck.db`.
- [ ] Report template: for each §10 bullet → `automated (which job) | physical (which device) | not covered (why)`.

**Acceptance for Phase 7:** every §10 bullet has a line in the report; Playwright green in CI; A11 + one portrait device + Electron green.

---

# Phase 8 — Documentation, regression tests, and release builds

### Task 8.1 — Layout model documentation
- Create: `docs/layout-model.md` — engine contract (inputs/outputs, scoring, clamp/scroll fallbacks), D2/D4 semantics, slot/position derivation rules, settings merge precedence, a worked example at 320 px and 1600 px. Referenced from `README.md` (one link line).

### Task 8.2 — Regression test hardening
- Extend `client/test/widgets.test.js` (it pins old `columnsFor` expectations — update/remove as `layout.js` shrinks in 3.1) and add slot-merge-sort fixtures; host: add `reorder_items` handler-shape test against `itemOrder` (pure, no WS import).
- [ ] Green `npm test` both packages + `npm run lint`.

### Task 8.3 — Release builds
- [ ] Bump versions following the repo convention (`chore: release X.Y.0` commits, cf. `dad9fdd`, `ea43584`); this is a minor-or-major call for the owner — recommend **2.4.0** given backward-compatible storage. Tag → CI produces APK (`android-release.yml` build-apk) + EXE (build-exe). Install both; run Phase 7.3 checklist against the *release* artifacts (debug builds are what `build-android.ps1` produces today, line 36 — release-APK signing is an existing owner-side step, reuse it).

---

# Cross-cutting risk register

| Risk | Blast radius | Mitigation |
|---|---|---|
| Mixed old-client / new-host fleets (`slot` ignored by old APKs) | Order drift visible only after new-client reorders | position-derivation (D2) keeps old views deterministic; ship both builds together (Phase 8) |
| `fullSensor` rotation surprise | Existing phone users | Release-note line; Android rotation lock respected by default |
| Playwright harness drift from real WS frames | False-green automated suite | Fixtures generated from a live `sendState` capture (copy one frame into `client/test/viewport/fixtures/`) |
| Engine scoring changes ripple everywhere | Both renderers | Scoring pinned by golden tests (assert exact layout JSON for 3 frozen viewports) |
| dnd-kit touch behavior inside `touch-action:none` + scroll (`scrollY` pages) | Edit mode on dense pages | Edit mode forces `touch-action:none` and auto-scrolls via DragOverlay movement thresholds; documented + covered by one Playwright edit-mode scroll case |
| `layout.js` import churn (DesktopApp imports `spanStyle,totalCells`) | Build break mid-phase | 3.1 keeps re-exports until 3.2 lands, then deletes |
| Status bar overlap (main.jsx override vs config) | Portrait safe areas | Task 4.1 unifies on `overlaysWebView:true` + `env()` padding; verified on device, not just build |

# What is NOT in this plan (explicitly deferred)

- 3x/4x spans, per-orientation stored overrides, layout export/import files, desktop edit-mode parity (desktop stays always-editable per §9), new widget types/metrics, backend metric pipeline changes, `electron` window-bounds persistence (unrelated to layout), Petdex-grade theming.

## Execution handoff

After approval: implement phase-by-phase with TDD per task, running `npm run lint && npm test && npm run build` (client+host) at every commit checkpoint, `build-android.ps1` + `adb install -r` at the end of Phases 4-5-7, `npm run dist` + Electron manual pass at the end of Phases 6-7-8 — and report, for each §10 item, whether the proof was automated (which job) or physical (which device), per the plan's Phase 7.3 template.

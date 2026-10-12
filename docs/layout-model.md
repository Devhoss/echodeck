# Layout Model Reference

The responsive deck grid is produced by a pure engine and consumed verbatim by
both renderers (phone and desktop). This document is the contract reference:
what the engine takes and returns, how it scores a grid, when it clamps or
scrolls, and how ordering (`slot` for tiles, `position` for pages) and settings
(`layout_config`, presets) are derived and merged. It is a reference, not a
tutorial — every claim cites the code that implements it.

Primary files:

| Concern | File |
| --- | --- |
| Engine (pure, no DOM) | `client/src/layout/deckLayout.js` |
| Measurement hook | `client/src/layout/useDeckLayout.js` |
| Client settings merge | `client/src/layout/layoutSettings.js` |
| Edit-mode draft (mobile) | `client/src/layout/layoutDraft.js` |
| Visible-page + order-batch helpers | `client/src/layout/deckPages.js` |
| Preset form/snapshot rules | `client/src/layout/layoutForm.js` |
| Preset REST layer | `client/src/layout/presetsClient.js` |
| Host slot/position derivation | `host/src/itemOrder.js` |
| Host page-order validation | `host/src/pageOrder.js` |
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
contract, not CSS auto-flow — the phone tile map's `placeStyle` inline
`gridColumn: col+1 / span span.cols` / `gridRow: row+1 / span span.rows`
(applied as `style={placeStyle}` in `App.jsx`; the desktop equivalents at
`DesktopApp.jsx:4054-4055,4122-4123`), and `scrollY` toggles the `deckGrid`
scroller's inline styles in `App.jsx` (`overflowY: "auto"` and
`touchAction: "pan-y"` when true).

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
(verified output in section 11).

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
`span: { cols: 1, rows: 2, clamped: true }` and still placed (section 11).

**Vertical scroll (height).** The fallback at `deckLayout.js:68-73` triggers
only when every candidate was rejected for `cell < minCell`. Because
`widthCap` guarantees `cellW >= 2·minCell` for any `cols <= cap`
(`deckLayout.js:52`), rejection can only come from `cellH` — i.e. the **height**
ran out, never the width. In that case the engine packs at `cap` (columns are
chosen from width alone), sets
`cell = floor(clamp(cellW, minCell, maxCell))` and `scrollY: true`; the renderer
then makes the deck vertically scrollable instead of clipping (the `deckGrid`
scroller's inline `overflowY`/`touchAction` in `App.jsx`). In custom mode the
scroll fallback still packs at `cap`,
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
  `db.js:791-810`) — no client can desync them.
- **Sanctioned writers.** WS `reorder_items` `{page_id, items:[{kind,id,slot}]}`
  (`server.js:1184-1203`); legacy WS `reorder_buttons`, folded into a full-page
  slot batch that preserves widget slots and lays the new button order back
  into the button-occupied slots (`server.js:545-598,1173-1182`); and
  `POST /api/items/move` for cross-page moves, which re-parents the row then
  applies both pages' reorders in one transaction (`server.js:606-641`,
  `itemOrder.js:131-175`, `db.js:838-864`). `slot` is in no PATCH whitelist —
  these writers derive it.
- **Append rule.** Newly created rows are stamped `slot = page's button count +
  widget count` (one SELECT), so they append at the tail of the merged order
  instead of interleaving mid-deck through the fallback (`db.js:771-789`,
  used by `createButton` `db.js:687` and `createWidget` `db.js:940`).
- **Read rule.** Page rows load `ORDER BY COALESCE(slot, position), rowid` —
  rows that predate slot adoption or were created outside the writers fall
  back to their legacy `position` (`db.js:626-633,756-769,896-903`).
- **Client merge.** Each surface builds one display list by stable-sorting
  `[...buttons, ...widgetsForPage]` on `(slot ?? position)`; ES stable sort
  breaks ties with merge order, so equal keys keep buttons ahead of widgets —
  the exact legacy rendering (`App.jsx:843-851`; desktop adds an optimistic
  slot overlay, `DesktopApp.jsx:436-448`). The mobile edit draft re-reads the
  same key and densifies each page to contiguous `0..n-1` slots, which is what
  `applyReorder` accepts back (`layoutDraft.js:35-41,137-168`); `diffDraft`
  emits full dense batches per affected page (`layoutDraft.js:285-352`).

## 7. Page order (final polish)

Pages have always been ordered by `pages.position` — `INTEGER DEFAULT 0` in the
original `CREATE TABLE pages` (`db.js:32-39`). Adopting page reordering needed
no schema migration; it added a UI and a wire verb over the existing key. Reads
are `getPages()`'s `SELECT * FROM pages ORDER BY position, rowid`
(`db.js:424-429`): the `rowid` tie-break keeps two rows that share a position
(possible only after a partial historical write) in stable relative order.

### 7.1 The wire: `reorder_pages {page_ids}`

- **The sanctioned writer.** WS `reorder_pages` `{v:1, t:"reorder_pages",
  page_ids:[...]}` (`server.js:1205-1218`) goes through `db.applyPageReorder`
  (`db.js:822-836`) — one guarded transaction whose only UPDATE is
  `pages.position`. This is the sanctioned writer of page order.
- **Visible-only contract, hidden pinned behind.** `page_ids` must be the
  complete permutation of the VISIBLE pages — hidden pages (the lazy "Unfiled"
  bucket) are not reorder targets, and naming one rejects the batch
  (`pageOrder.js:54-59`). The position map then pins every hidden page strictly
  after the last visible one, preserving their relative order
  (`pageOrder.js:69-76`). That is what keeps `pages[0]` navigable no matter
  what a client submits — and why a newly paired phone never lands on Unfiled.
- **All-or-nothing, and rejection is silence.** Any missing, unknown,
  duplicated, or hidden-naming id rejects the whole batch with nothing written
  (`pageOrder.js:32-78`, shared normaliser `pageOrder.js:94-98`). The host
  logs a warning and returns — no ack frame, no broadcast
  (`server.js:1213-1216`). A rejected batch is therefore invisible on the
  socket, which is precisely why the phone's heal rules and its claim-gated
  order batch exist (7.4).
- **PATCH is an escape hatch, not the ordering path.** `position` remains in
  the `PAGE_FIELDS` whitelist (`db.js:451-457`), so `PATCH /api/pages/:id`
  (`server.js:395-403`) can still write it per page — but a single-page write
  is non-atomic: it cannot express a full visible permutation nor re-pin the
  hidden tail, so it can break the hidden-last invariant. No client uses it
  for ordering; the ws frame above is the only path the clients use to
  reorder. The create-page
  route keeps its own contribution consistent by re-densifying through the
  sanctioned writer right after inserting (`server.js:379-386`).
- **What reordering never rewrites.** The writer touches only `position`:
  page `id`, `name`, `show_labels`, `hidden` and `layout_config` are untouched
  (`db.js:812-821`), and item `page_id`/`slot` are untouched by definition —
  the item writers of section 6 stay the only ones. Profile rules are
  unaffected: rules bind by `page_id` and rank by `priority`
  (`ruleEngine.js:22`), independent of page order.

### 7.2 Two commit models

The same phone/desktop asymmetry as tile drag (section 6):

- **Mobile: draft-scoped.** While in Edit Layout the order lives in
  `draft.pageOrder`, built at draft entry from `visibleDeckPages(pages)` and
  changed only by `shiftPage` (the toolbar's Earlier/Later rows,
  `layoutDraft.js:218`, `DeckEditorBar.jsx:169`). The pager repaints
  immediately from the draft via `pagesInOrder` (`deckPages.js:12-24`, wired
  as `pagerPages` at `App.jsx:876-880`) — no host write. **Save commits**: the
  single `reorder_pages` frame is the last step of the full draft diff, after
  every `reorder_items` batch, so a Unfiled page materialized mid-Save is
  already hidden and pinned by the host before the deck order lands
  (`App.jsx`, `handleSave`'s step (e) — the `reorder_pages` send).
  **Done discards**: the draft is dropped (`handleDone` in `App.jsx`) and
  nothing was ever sent.
- **Desktop: immediate.** The desktop canvas has no draft, so a page-rail drop
  re-sorts optimistically and an immediate debounced (300 ms) `reorder_pages`
  is the write (`DesktopApp.jsx:1566-1591`) — exactly the model tile drags
  already use with `reorder_items` (`DesktopApp.jsx:1594-1625`). The optimistic
  model re-appends the hidden pages behind the visible block
  (`DesktopApp.jsx:1577-1580`), mirroring the host's pinning so the local
  order equals the permutation about to be stored. A rejection self-converges:
  the rail repaints from the next host `state` echo — a batch is only ever
  rejected when the visible page set changed, and that change is itself a host
  broadcast, so the echo always comes — and desktop needs no Save-gate retry
  machinery.

### 7.3 Desktop page-rail drag conventions

- **One `DndContext`, prefixed ids.** The rail pills are sortable under the
  deck's single `DndContext` (`DesktopApp.jsx:1765-1771`; the rail renders at
  `:1950` inside it), so their sortable ids carry a `page:` prefix —
  `pageSortableId(id) = "page:" + id` (`DesktopApp.jsx:138-142`). The prefix
  namespaces pills away from tile ids (raw uuids and `widgettile:`) and
  library ids (`action:`/`app:`/`widget:`); a tile drop can never match a
  `page:<uuid>` key, so the tile-reorder router misses on it
  (`DesktopApp.jsx:1601-1604`), and no branch can put a `page:` id into
  `items` or `page_ids`.
- **Dim vs hide — the rule.** A dragged sortable stays visible by dimming
  (`opacity: 0.3`) unless the `DragOverlay` carries a ghost of it. The overlay
  draws ghosts for button, action and widget actives only
  (`DesktopApp.jsx:1892-1948`) — no ghost exists for a `page:` active — so a
  dragged page pill dims to 0.3 and keeps its slot rather than vanishing
  (`PageRailPill`'s `opacity: isDragging ? 0.3 : 1` line in `DesktopApp.jsx`),
  like the button tile (`:4034`). The
  widget tile is the one that hides to 0 (`DesktopApp.jsx:4121-4131`) — and
  only because the overlay draws its ghost at the tile's real footprint, sized
  with the same `spanFor`-derived cell/gap the grid uses
  (`DesktopApp.jsx:1904-1922`). This convention was re-derived twice during
  review; it is written once here so the next reader does not re-derive it.
- **Keyboard.** The rail shares the deck's sensors — `PointerSensor` (6 px
  activation) and `KeyboardSensor` with `sortableKeyboardCoordinates`
  (`DesktopApp.jsx:502-510`); Space/Enter grab, arrows move.

### 7.4 Phone heal rules

These exist because Save is optimistic and a rejected batch is met with
silence (7.1). The draft carries a `pageOrderClaim` flag: `shiftPage` sets it
only when a tap really moves a page (`layoutDraft.js:234`), item ops and draft
rebuilds carry it through, and it says "this session authored the order and
the host has not yet confirmed it". The `state` frame handler runs three
behaviours over it, on both `draft` and `baseDraft` (`App.jsx:661-668`), and
the ORDER heal runs on EVERY frame — it no longer waits for the Save window
(only the ITEM re-seed stays gated; the gate exists because item writes echo
back out of order, and the order axis has no such race):

- **No claim: the draft follows the host's order.**
  `followHostPageOrder(draft, visibleIds)` mirrors the host's visible sequence
  outright, same reference when it already matches (`layoutDraft.js:282-293`).
  A phone that never touched the Pages rows has no opinion, so another
  client's reorder lands on screen immediately and can never be re-asserted
  by this phone's next unrelated Save.
- **Claim outstanding: set-heal only.** `reconcilePageOrder(draft, visibleIds)`
  prunes ids the host no longer shows and appends host-new ones, never
  re-sorting — a surviving id keeps its slot, so the unsaved claim is never
  clobbered (`layoutDraft.js:253-273`). It keeps
  `set(draft.pageOrder) === set(visible page ids)` at all times, so
  `pagesInOrder` stays a pure permutation (an unowned/dead toolbar row is
  unrepresentable) and a stale id can never poison the all-or-nothing batch
  forever.
- **Host agreement closes the claim.** When the healed order is exactly the
  host's sequence, `reconcilePageOrder` clears `pageOrderClaim`
  (`layoutDraft.js:262-264`): the confirmation frame has arrived, and the
  draft goes back to following.

The order batch is measured against the host, and only an authored claim may
assert one. `pageOrderBatch(draft, hostIds)` returns the draft's whole order
whenever it differs from the host's visible order — a length mismatch means
the heal owns that case, so it stays `[]` (`deckPages.js:26-38`).
`pendingPageOrder` consults it only when `draft.pageOrderClaim` stands
(`App.jsx:1006-1015`), so an unclaimed draft never re-asserts someone else's
reorder, while a claim the baseline accepted but the host rejected keeps Save
enabled: the user taps Save and the order is re-committed. A baseline-only
comparison would strand that claim — draft equal to baseline, Save dark, the
only exit leaving Edit Layout. The resulting `pendingPageOrder` feeds BOTH
`dirty` and the Save frame (`App.jsx:1020-1035,1405-1412`).

## 8. Surface split: phone vs desktop (final polish)

The owner's division of the two surfaces, now settled:

- **The phone's control sheet is status + disconnect + Edit Layout.** Its grid
  holds exactly two rows: the stats row (when `stats` is present) and one
  combined row with the connection pill, Disconnect and Edit Layout
  (`ControlSheet.jsx:248-352`). It carries no volume or mic controls.
- **Detailed layout settings and presets are desktop-only.**
  `LayoutSettingsForm` renders only in the desktop's Layout Settings modal —
  the `showLayoutSettings`-guarded block in `DesktopApp.jsx`, at the
  component's single render site — with its Presets section live (the form
  receives `presets`/`onSavePreset`/`onApplyPreset`/`onDeletePreset` there).
  The phone still *renders* a desktop-configured layout — its read-only global
  fetch is `App.jsx:795-821` and the section 10 merge is shared — but it
  writes no layout config and exposes no preset affordance.
- **Volume/mic are deck actions, not sheet controls.** Hold lives on deck
  buttons; the hold-repeat itself is host-side — `volume_hold_start` installs
  an 80 ms interval per client behind a generation guard, `volume_hold_stop`
  tears it down (`server.js:1072-1132`).

## 9. D4: presets persist layout settings, not tile placements

Two distinct things are called "preset"; keep them apart:

- **Engine presets** (`compact`/`balanced`/`large`) are cell-size bound sets
  inside `settings.preset` (section 2).
- **Saved layout presets** (plan D4/D7) are rows in `layout_presets`
  (`db.js:135-144`) holding a named JSON snapshot
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
  (`layoutForm.js:175-222`).
- **Wire.** `GET/POST/DELETE /api/layout-presets`; there is no PUT — a preset
  is immutable, edit it by delete + recreate (`server.js:651-676`,
  `presetsClient.js:47-74`).
- **Apply.** One whole-replacement write per mentioned scope:
  `POST /api/settings {key:"layout_config"}` for `defaults`, `PATCH
  /api/pages/:id {layout_config}` for each page entry. Scopes the preset does
  not mention are left alone; apply fires **no** `reorder_items`, no
  `/api/items/move`, and no size PATCHes — placements are untouchable through
  presets (`handlePresetApply` in `DesktopApp.jsx`; the per-scope jobs it
  builds are the entries it pushes onto its local `jobs` array — the
  `label: "global"` POST and the `label: "page"` PATCHes). Saving and applying
  presets live only on the desktop — section 8.

## 10. Settings merge precedence

The real precedence chain the client renders with is
**defaults → global → page** (`layoutSettings.js:1-7`):

```
settings = { ...DEFAULT_SETTINGS, ...sanitize(globalLayout), ...sanitize(pageLayoutConfig) }
```

- `globalLayout` is the deck-wide `layout_config` stored in the `settings`
  key/value table and delivered only via `GET /api/settings`
  (`server.js:224-240,242-271`; fetched at `App.jsx:795-821`). The `state`
  frame carries each page's `layout_config` but no global scope, so the
  deck-wide value is not on the socket — it arrives only from the settings
  fetch.
- The page scope is `pages.layout_config` (`db.js:240-243`), parsed to an
  object or `null` in page serialization (`server.js:1318-1328`).
- `mergeLayout` (`layoutSettings.js:43-49`) sanitizes each scope with the
  client mirror of the host rules: invalid or absent keys are dropped, which
  reads as "no opinion at this scope" and falls through to the next layer,
  finally `DEFAULT_SETTINGS` (`layoutSettings.js:24-36`). A `null`/absent
  global (unpaired, fetch pending) contributes nothing.
- Presets are **not** a fourth render-time layer. Applying one only rewrites
  the stored global/page scopes (section 9); from the next state frame the
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
  cascade (`layoutForm.js:136-142`; `server.js:253-257`, `db.js:417-421,
  459-481`).

## 11. Worked examples (real engine output)

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

## 12. Verification coverage

An honest map of what the suites guard — and what no suite can.

**Automated.**

- **Host** (`cd host && npm test`). `host/test/pageOrder.test.js` pins the
  pure validator: complete-visible-permutation acceptance, hidden pinned
  strictly behind the visible block, all-or-nothing rejection of missing /
  unknown / duplicate / hidden-naming / non-string ids, and `firstVisiblePage`
  never surfacing a hidden page. `host/test/reorderPagesHandler.test.js`
  hand-mirrors the `server.js` `reorder_pages` block and cannot import the
  real handler, so it proves the mirrored contract, not the real handler's
  frame emission. What DOES pin "an invalid batch writes nothing and answers
  with silence — no ack frame" (7.1) is the final-polish isolated-host run:
  this branch's unmodified `host/src/server.js` under `ELECTRON_RUN_AS_NODE`
  against a throwaway db, where a rejected batch produced no ack and no
  broadcast in the host log and the stored order stayed unchanged. Item
  ordering stays covered by `itemOrder.test.js` and
  `reorderItemsHandler.test.js`.
- **Client unit** (`cd client && npm test`). `test/deckPages.test.js` covers
  `visibleDeckPages`, `pagesInOrder` (identity-preserving permutation,
  unmentioned pages trailing, unknown ids dropped) and `pageOrderBatch` —
  including its host-measured rule that a draft order differing from the
  host's always produces a batch (7.4). `test/layoutDraft.test.js` covers the
  draft's page-order axis end to end: `createDraft` seeding, `shiftPage`
  moves (and the `pageOrderClaim` a real move authors, while dead ends return
  the same reference), claim preservation across item ops,
  `reconcilePageOrder` set-equality healing on both sides without re-sorting
  survivors — including keeping an outstanding claim and clearing the one the
  host just confirmed — `followHostPageOrder` mirroring, and
  `diffDraft().pageOrder` (which deliberately never reports the claim).
- **Playwright viewport matrix** (`cd client && npm run test:viewport`): 14
  viewports (`test/viewports.js`) × 13 tests (`test/viewport/deck.spec.ts`),
  182 runs, against a mock socket. Tests 1-3 guard no horizontal overflow and
  tiles landing on the engine's measured grid; the shared edit-mode entry
  helper `enterEditMode` opens the sheet and asserts
  `scrollHeight - clientHeight <= 1`, so a sheet row that ever outgrows the
  220-px landscape cap fails. Tests 7-13 are the mobile page-reorder suite,
  cited by test number and name: test 7 "pages: the Unfiled page stays out of
  navigation, and a move emits reorder_pages" — a committed move emits exactly
  one `reorder_pages`, after the item reorders, as `handleSave`'s step (e);
  test 8 "pages: Done (Discard) restores the original page order and never
  writes it"; test 9 "pages: a pending page move survives a mid-draft fold and
  a host re-seed"; test 10 "pages: a rejected order stays saveable and
  re-commits on a second Save", proving the host-measured batch rule; test 11
  "pages: a page created mid-draft becomes a live, reorderable row"; test 12
  "pages: a remote reorder is followed, never re-asserted by an unrelated
  Save" — an unclaimed draft mirrors the host's new order, Save stays dark,
  and the item-only Save emits zero `reorder_pages` frames; test 13 "pages: a
  remote delete inside the Save window still heals and stays committable" —
  a delete frame pushed from inside a held `PATCH /api/buttons/1` route lands
  while `saveInFlight` is true, the order heal (ungated, unlike the item
  re-seed) still prunes the dead row, and Save re-lights for the still
  unaccepted order.

**Not automated — human passes only.**

- dnd-kit sensors do not activate under Playwright's synthetic pointer events
  (the desktop `PointerSensor` requires a real 6 px trusted drag,
  `DesktopApp.jsx:502-505`), so no CI test drags anything. The desktop tile
  drag affordances, `KeyboardSensor` tab-then-space moves, and the page-rail
  pill drag (7.3) are verified only by a manual Electron pass.
- Phone volume hold-repeat needs a real finger on a hardware button; the
  host-side interval machinery behind it (`server.js:1072-1132`) has no
  automated test either.
- The Android device pass and the Electron desktop pass are scheduled
  follow-ups; nothing in this document claims they have run.

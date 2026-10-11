# Final Layout Polish Before Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Four focused follow-up changes on `feat/responsive-layout` — a compact phone control sheet with no volume/mic rows, detailed layout settings moved to desktop-only, visible drag affordances for desktop widget tiles, and page reordering (desktop rail drag + mobile Edit Layout) that persists and syncs.

**Architecture:** The phone is a *dashboard* (operate buttons, watch widgets, check status); the desktop is the *configuration surface*. Page order rides the already-existing `pages.position` column through a new atomic `reorder_pages` ws frame, mirroring `reorder_items`. On mobile, page order joins the Edit Layout **draft**, so Save commits item layout and page order together and Discard reverts both.

**Tech stack:** React 19 + Vite (phone renderer `App.jsx`, Electron renderer `desktop/DesktopApp.jsx`), `@dnd-kit/core` + `@dnd-kit/sortable` 10, Express + ws + better-sqlite3 host, `node --test` for pure modules, Playwright for the phone viewport matrix.

**Spec:** `docs/superpowers/plans/2026-10-10-responsive-layout-and-mobile-customization.md` (parent plan; decisions D1–D4 and D7/D8 still bind). No separate spec file exists for this follow-up — the design the owner approved in conversation on 2026-10-11 is the authority, and it is reproduced in the Global Constraints below.

## Global Constraints

- **Branch:** all work stays on `feat/responsive-layout` (HEAD `a348b1e`). **Do not merge, push, tag, or publish.** No `git checkout main`, no PR, no `git tag`.
- **Never stage `host/package-lock.json`** — it is intentional working-tree noise in this repo.
- **This is a follow-up, not a redesign.** Do not restart the eight-phase work or rewrite completed functionality. Volume and microphone *actions* (deck buttons, action library, desktop Audio controls, hold-repeat) must keep working; only the sheet's control rows are removed.
- **Mobile = dashboard, desktop = configuration.** Detailed layout settings and presets live on desktop only after Task 5.
- **Page reorder is draft-scoped on mobile:** Save commits page order and item-layout changes together; Discard restores the original page order. Never write page order to the host mid-draft. (Desktop has no draft — its canvas is always-live — so a desktop rail drag commits immediately, exactly like a desktop tile drag does today.)
- **Unfiled stays hidden.** It remains absent from the pager dots, the desktop PageRail, deck swipe, and the `reorder_pages` batch, and stays reachable for recovery through Edit Layout. A hidden page is always positioned after every visible one, so `pages[0]` is never Unfiled.
- **Ordering model (D2) unchanged:** `slot` is authoritative, `position` is server-derived; reordering a widget must preserve `id`, `page_id`, `type`, `size`, `label`, `icon`, `color`, `source_id`, `config`, and the source's `refresh_ms`. No new npm dependencies.
- **Gesture contracts preserved:** sheet tap-to-open, pull-down-to-open, Escape/outside-tap/up-swipe dismissal; page swiping; button tap-vs-drag arbitration; long-press-to-enter-edit; library→deck drag on desktop.
- **Test runners:** `node --test` only (no jsdom/vitest) — JSX render memos in `App.jsx`/`DesktopApp.jsx` are not unit-testable; cover them with the Playwright matrix (phone) and a manual Electron pass (desktop). Never claim device or viewport coverage that was not actually run.
- **Host safety:** never point a test at the real `macro-deck.db`. Isolated host runs redirect `USERPROFILE`/`APPDATA`/`LOCALAPPDATA` to `E:\temp\echodeck-test-home`. `host/package.json` test command is `node --test`; `client/package.json` is `node --test "test/**/*.js"`.
- **Commits:** one commit per task, conventional style matching `git log` (`feat(client): …`, `fix(host): …`, `refactor(client): …`, `docs: …`).

---

### Task 1: Pure page-order validator (`host/src/pageOrder.js`)

**Files:**
- Create: `host/src/pageOrder.js`
- Create: `host/test/pageOrder.test.js`

**Interfaces:**
- Consumes: nothing (zero requires, like `host/src/itemOrder.js`).
- Produces: `applyPageOrder(existingPages, submittedIds) -> { positions: Map<string,number> } | { error: string }` and `firstVisiblePage(pages) -> page | null`. Task 2 imports `applyPageOrder`; Task 3 imports `firstVisiblePage` into `host/src/server.js`.

- [ ] **Step 1: Write the failing tests**

Create `host/test/pageOrder.test.js`. Style follows `host/test/itemOrder.test.js` (CJS, `node:test` + `node:assert/strict`, header explains why the math is pure, `// --- section ---` banners):

```js
/**
 * Page-order tests (final polish, page reordering). Pure module, `node --test`,
 * no DB: db.js loads better-sqlite3 compiled against Electron's ABI, so all page
 * order math lives here (the itemOrder.js precedent, see its header).
 *
 * `applyPageOrder` reads only { id, hidden } from existing rows. `hidden` is
 * accepted as either a 0/1 integer (raw SELECT rows) or a boolean (post
 * toDeckPage) — both are tested.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyPageOrder, firstVisiblePage } = require("../src/pageOrder");

const P = (...specs) => specs.map(([id, hidden]) => ({ id, hidden }));

// --- applyPageOrder: success ---

test("applyPageOrder rewrites positions in submitted order", () => {
  const rows = P(["a", 0], ["b", 0], ["c", 0]);
  const { positions, error } = applyPageOrder(rows, ["c", "a", "b"]);
  assert.equal(error, undefined);
  assert.deepEqual([...positions], [["c", 0], ["a", 1], ["b", 2]]);
});

test("applyPageOrder accepts a single visible page unchanged", () => {
  const { positions, error } = applyPageOrder(P(["a", 0]), ["a"]);
  assert.equal(error, undefined);
  assert.deepEqual([...positions], [["a", 0]]);
});

test("applyPageOrder pins hidden pages after every visible one, keeping their relative order", () => {
  // The invariant that keeps pages[0] non-hidden however the client reorders.
  const rows = P(["a", 0], ["u", 1], ["b", 0], ["v", 1]);
  const { positions, error } = applyPageOrder(rows, ["b", "a"]);
  assert.equal(error, undefined);
  assert.equal(positions.get("b"), 0);
  assert.equal(positions.get("a"), 1);
  assert.equal(positions.get("u"), 2); // hidden block starts at visibleCount
  assert.equal(positions.get("v"), 3); // …and keeps u-before-v
});

test("applyPageOrder treats boolean hidden the same as 0/1 hidden", () => {
  const rows = [{ id: "a" }, { id: "b", hidden: false }, { id: "u", hidden: true }];
  const { positions, error } = applyPageOrder(rows, ["b", "a"]);
  assert.equal(error, undefined);
  assert.deepEqual([...positions], [["b", 0], ["a", 1], ["u", 2]]);
});

// --- applyPageOrder: rejections ---

test("applyPageOrder rejects a batch that misses a visible page", () => {
  const rows = P(["a", 0], ["b", 0], ["c", 0]);
  const result = applyPageOrder(rows, ["a", "b"]);
  assert.equal(result.positions, undefined);
  assert.match(result.error, /must cover every visible page/);
});

test("applyPageOrder rejects a batch that covers more pages than exist", () => {
  const result = applyPageOrder(P(["a", 0], ["b", 0]), ["a", "b", "c"]);
  assert.match(result.error, /unknown page id "c"/);
});

test("applyPageOrder rejects an unknown id before the coverage check", () => {
  const result = applyPageOrder(P(["a", 0]), ["z"]);
  assert.match(result.error, /unknown page id "z"/);
});

test("applyPageOrder rejects a duplicate id", () => {
  const result = applyPageOrder(P(["a", 0], ["b", 0]), ["a", "a"]);
  assert.match(result.error, /duplicate page id "a"/);
});

test("applyPageOrder rejects a hidden id inside the submitted batch", () => {
  // The batch describes the VISIBLE order; Unfiled is never a drag target.
  const rows = P(["a", 0], ["b", 0], ["u", 1]);
  const result = applyPageOrder(rows, ["u", "a", "b"]);
  assert.match(result.error, /hidden page "u" is not part of the visible order/);
});

test("applyPageOrder rejects non-string ids and non-arrays", () => {
  assert.match(applyPageOrder(P(["a", 0]), [1]).error, /must be strings/);
  assert.match(applyPageOrder(P(["a", 0]), "a").error, /must be an array/);
  assert.match(applyPageOrder("nope", ["a"]).error, /must be an array/);
});

test("applyPageOrder tolerates an empty existing set and an empty batch", () => {
  const { positions, error } = applyPageOrder([], []);
  assert.equal(error, undefined);
  assert.equal(positions.size, 0);
});

// --- firstVisiblePage ---

test("firstVisiblePage returns the first non-hidden row", () => {
  assert.equal(firstVisiblePage(P(["u", 1], ["a", 0], ["b", 0])).id, "a");
});

test("firstVisiblePage returns null for empty, null, and all-hidden input", () => {
  assert.equal(firstVisiblePage([]), null);
  assert.equal(firstVisiblePage(null), null);
  assert.equal(firstVisiblePage(P(["u", 1])), null);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd host && node --test test/pageOrder.test.js`
Expected: FAIL — `Cannot find module '../src/pageOrder'`.

- [ ] **Step 3: Write the module**

Create `host/src/pageOrder.js`:

```js
/**
 * pageOrder.js — host/src/pageOrder.js
 *
 * Page reordering (final polish). Pure — imports nothing, so it stays testable
 * under plain `node --test` while `db.js` cannot be loaded there (better-sqlite3
 * is compiled against Electron's ABI). Same precedent as itemOrder.js.
 *
 * ── The visible/hidden split ────────────────────────────────────────────────
 * A `reorder_pages` batch describes the VISIBLE order only. Hidden pages (the
 * lazy "Unfiled" bucket, plan D3) are never offered as reorder targets, so they
 * are pinned to positions strictly after the last visible one, keeping their
 * existing relative order. That is what guarantees `pages[0]` is never a hidden
 * page — no matter what a client submits — and it is why a newly paired phone
 * cannot land on Unfiled (server.js sendState) and auto-switch cannot fall back
 * to it (performSwitch).
 *
 * `hidden` is read falsy-first, so it accepts raw SELECT rows (0/1 INTEGER) and
 * post-`toDeckPage` rows (boolean) alike.
 *
 * ── All-or-nothing ──────────────────────────────────────────────────────────
 * Like itemOrder.applyReorder: any violation rejects the whole batch and returns
 * `{ error }`, never a partial map. A client that submits a scrambled-but-
 * complete visible set gets exactly that order; one that misses or invents a
 * page gets nothing written.
 */

/**
 * existingPages = [{ id, hidden }] in current DB order; submittedIds = the full
 * visible id list in the wanted order. Returns { positions: Map<id, position> }
 * covering EVERY page (visible and hidden), or { error }.
 */
function applyPageOrder(existingPages, submittedIds) {
  if (!Array.isArray(existingPages)) {
    return { error: "existingPages must be an array of {id, hidden}" };
  }
  if (!Array.isArray(submittedIds)) {
    return { error: "submittedIds must be an array of page ids" };
  }

  const known = new Map(); // id -> hidden(boolean)
  for (const page of existingPages) {
    if (!page || typeof page.id !== "string") {
      return { error: "every existing page needs a string id" };
    }
    if (known.has(page.id)) {
      return { error: `duplicate page id "${page.id}" in the existing rows` };
    }
    known.set(page.id, !!page.hidden);
  }

  const visibleCount = [...known.values()].filter((hidden) => !hidden).length;

  const seen = new Set();
  for (const id of submittedIds) {
    if (typeof id !== "string") return { error: "submitted page ids must be strings" };
    if (!known.has(id)) return { error: `unknown page id "${id}"` };
    if (known.get(id)) {
      return { error: `hidden page "${id}" is not part of the visible order` };
    }
    if (seen.has(id)) return { error: `duplicate page id "${id}" in the submitted batch` };
    seen.add(id);
  }
  if (submittedIds.length !== visibleCount) {
    return {
      error: `submitted batch must cover every visible page (${submittedIds.length} submitted, ${visibleCount} visible)`,
    };
  }

  // Unique, known, non-hidden and exactly `visibleCount` long: a full
  // permutation of the visible set, so dense 0..n-1 is safe to write.
  const positions = new Map();
  submittedIds.forEach((id, i) => positions.set(id, i));
  let next = visibleCount;
  for (const page of existingPages) {
    if (page.hidden) positions.set(page.id, next++);
  }
  return { positions };
}

/** First row a client may legitimately land on. Null when none are visible. */
function firstVisiblePage(pages) {
  if (!Array.isArray(pages)) return null;
  return pages.find((p) => p && !p.hidden) ?? null;
}

module.exports = { applyPageOrder, firstVisiblePage };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd host && node --test test/pageOrder.test.js`
Expected: PASS — 13 tests, 0 failures.

- [ ] **Step 5: Run the full host suite**

Run: `cd host && npm test`
Expected: PASS (135 existing + 13 new).

- [ ] **Step 6: Commit**

```bash
git add host/src/pageOrder.js host/test/pageOrder.test.js
git commit -m "feat(host): add pure page-order validator for page reordering"
```

---

### Task 2: Page-position writer (`host/src/db.js`)

**Files:**
- Modify: `host/src/db.js` — `getPages()` `:423-425`, new `applyPageReorder` beside `applyItemReorder` `:791-806`, the slot-writer export group `:1039-1041`, and the module's existing `itemOrder` require at the top.

**Interfaces:**
- Consumes: `applyPageOrder` from Task 1.
- Produces: `db.applyPageReorder(submittedIds) -> { ok: true } | { error }`; `db.getPages()` now returns a deterministic order (`position, rowid`). Task 3's ws handler is the only consumer.

- [ ] **Step 1: Import the pure validator**

Find the existing require of `itemOrder` near the top of `host/src/db.js` (it names `backfillSlots` / `applyReorder` / `moveItemSlots`). Add next to it:

```js
const { applyPageOrder } = require("./pageOrder");
```

- [ ] **Step 2: Give `getPages()` a stable tie-break**

Replace `db.js:423-425` with:

```js
function getPages() {
  // FEATURE: Page reordering — `rowid` is the tie-break, so two rows sharing a
  // position (possible only after a partial historical write) keep a stable
  // relative order instead of an unspecified one.
  return db.prepare("SELECT * FROM pages ORDER BY position, rowid").all();
}
```

- [ ] **Step 3: Add the writer**

Insert after `applyItemReorder` (which ends at `db.js:806`), inside the same `// --- Slot writers` section and above the same "only sanctioned writers" idea:

```js
/**
 * The sanctioned page-order writer (final polish). `submittedIds` is the full
 * VISIBLE id list in the wanted order; applyPageOrder pins hidden pages after it
 * so Unfiled can never become pages[0]. One transaction writing only
 * `pages.position` — ids, names, show_labels, hidden and layout_config are never
 * touched, and item slots/page_id are untouched by definition (the item writers
 * above stay the only ones). Returns {ok} or {error} with nothing written.
 */
function applyPageReorder(submittedIds) {
  const rows = getPages();
  const result = applyPageOrder(rows, submittedIds);
  if (result.error) return { error: result.error };
  const update = db.prepare(`UPDATE pages SET position=? WHERE id=?`);
  db.transaction(() => {
    for (const [id, position] of result.positions) update.run(position, id);
  })();
  return { ok: true };
}
```

- [ ] **Step 4: Export it**

In the `module.exports` block, add `applyPageReorder,` immediately after `moveItemToPage,` (`db.js:1041`).

- [ ] **Step 5: Verify the module still loads and the suite is green**

Run: `cd host && node -e "require('./src/pageOrder'); console.log('ok')"` — expect `ok`.
Run: `cd host && npm test` — expect PASS. (`db.js` itself is not importable under system node by design; the math is covered by Task 1 and the frame contract by Task 3.)

- [ ] **Step 6: Commit**

```bash
git add host/src/db.js
git commit -m "feat(host): add transactional page-position writer"
```

---

### Task 3: `reorder_pages` ws kind + Unfiled-safe page fallbacks (`host/src/server.js`)

**Files:**
- Modify: `host/src/server.js` — new handler after `reorder_items` `:1173-1192`, `POST /api/pages` `:366-382`, `sendState` `:1230`, `performSwitch` `:1339`, and the require line for `itemOrder`/`pageOrder` at the top.
- Create: `host/test/reorderPagesHandler.test.js`

**Interfaces:**
- Consumes: `db.applyPageReorder` (Task 2), `firstVisiblePage` (Task 1).
- Produces: ws frame `{ v: 1, t: "reorder_pages", page_ids: string[] }` → on success `broadcastState()` pushes the re-sorted `pages` array to desktop and every phone; on rejection `console.warn` + `return` with **no broadcast** (same contract as `reorder_items`). Tasks 8 and 10 send this frame.

- [ ] **Step 1: Write the failing handler-contract test**

Create `host/test/reorderPagesHandler.test.js`. It follows `host/test/reorderPagesHandler`'s sibling `reorderItemsHandler.test.js`: import only the pure function and keep a verbatim copy of the handler's normalisation, so the frame contract is pinned without a socket or DB.

```js
/**
 * reorder_pages frame-contract test (final polish). Like
 * reorderItemsHandler.test.js this cannot import server.js or db.js (ABI), so
 * the handler's normalisation step is mirrored here VERBATIM from server.js —
 * edit both together if the frame shape changes. The writer it feeds is
 * validated by test/pageOrder.test.js.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyPageOrder } = require("../src/pageOrder");

// verbatim from server.js: the handler coerces a non-array to [] and filters out
// non-string ids so a malformed frame rejects cleanly instead of throwing.
function normalizePageIds(msg) {
  return (Array.isArray(msg.page_ids) ? msg.page_ids : []).filter(
    (id) => typeof id === "string",
  );
}

function handle(msg, pages) {
  return applyPageOrder(pages, normalizePageIds(msg));
}

test("reorder_pages: a complete visible batch yields dense positions", () => {
  const pages = [
    { id: "a", hidden: 0 },
    { id: "b", hidden: 0 },
  ];
  const { positions, error } = handle({ page_ids: ["b", "a"] }, pages);
  assert.equal(error, undefined);
  assert.deepEqual([...positions], [["b", 0], ["a", 1]]);
});

test("reorder_pages: a missing string id is filtered, so the batch under-covers and rejects", () => {
  const pages = [{ id: "a", hidden: 0 }, { id: "b", hidden: 0 }];
  const result = handle({ page_ids: ["b", 7] }, pages);
  assert.equal(result.positions, undefined);
  assert.match(result.error, /must cover every visible page/);
});

test("reorder_pages: a missing or non-array page_ids rejects instead of throwing", () => {
  const pages = [{ id: "a", hidden: 0 }];
  assert.match(handle({}, pages).error, /must cover every visible page/);
  assert.match(handle({ page_ids: "a" }, pages).error, /must be an array/);
});

test("reorder_pages: an attempt to reorder Unfiled into the visible deck rejects", () => {
  const pages = [
    { id: "a", hidden: 0 },
    { id: "u", hidden: 1 },
  ];
  const result = handle({ page_ids: ["u", "a"] }, pages);
  assert.match(result.error, /hidden page "u"/);
});

test("reorder_pages: hidden pages keep tail positions regardless of the batch", () => {
  const pages = [
    { id: "a", hidden: 0 },
    { id: "b", hidden: 0 },
    { id: "c", hidden: 0 },
    { id: "u", hidden: 1 },
  ];
  const { positions } = handle({ page_ids: ["c", "a", "b"] }, pages);
  assert.deepEqual(
    [...positions].map(([id, p]) => `${id}=${p}`),
    ["c=0", "a=1", "b=2", "u=3"],
  );
});
```

- [ ] **Step 2: Run it to verify the mirror works but the handler is missing**

Run: `cd host && node --test test/reorderPagesHandler.test.js`
Expected: PASS (5 tests) — this test pins the contract; Step 3 then makes the server actually honour it. If it fails, the copy is not verbatim: fix the test, not the expectation.

- [ ] **Step 3: Import `firstVisiblePage` and add the handler**

At the top of `host/src/server.js`, next to the existing `itemOrder` require, add:

```js
const { firstVisiblePage } = require("./pageOrder");
```

Then insert immediately after the `reorder_items` block (which ends at `server.js:1192`):

```js
    if (msg.t === "reorder_pages") {
      // FEATURE: Page reordering — {page_ids:[...]} is the VISIBLE order only,
      // so Unfiled is never part of a drag list (plan D3) and applyPageOrder can
      // pin every hidden page behind it. All-or-nothing like reorder_items: a
      // malformed frame is rejected with no broadcast, so no client flickers.
      const page_ids = (Array.isArray(msg.page_ids) ? msg.page_ids : []).filter(
        (id) => typeof id === "string",
      );
      const result = db.applyPageReorder(page_ids);
      if (result.error) {
        console.warn(`[reorder_pages] rejected: ${result.error}`);
        return;
      }
      broadcastState();
    }
```

- [ ] **Step 4: Make `sendState` land on a visible page**

Replace `server.js:1230`:

```js
  // Page reordering made `pages[0]` a moving target that a client could, in
  // principle, put a hidden page onto — so a fresh connection asks for the first
  // VISIBLE page instead. applyPageReorder already pins hidden pages to the
  // tail; this is the second half of that guarantee.
  const targetPage = page_id || autoPageId || firstVisiblePage(pages)?.id;
```

- [ ] **Step 5: Make auto-switch's fallback visible**

Replace `server.js:1339` inside `performSwitch`:

```js
  const nextPageId = rule?.page_id || firstVisiblePage(pages)?.id || pages[0].id;
```

- [ ] **Step 6: Make a new page join after the last visible one**

Replace `server.js:367` and `:375` inside `POST /api/pages` so a hidden tail row can't be collided with:

```js
  const pages = db.getPages();
  // Page reordering pins hidden pages at the tail, so a new page takes the slot
  // just past the last VISIBLE page rather than `pages.length` — with an Unfiled
  // page present those two values differ, and `pages.length` would land the new
  // page behind Unfiled and re-sort it into the visible block on the next read.
  const position = pages.filter((p) => !p.hidden).length;
```

…and change the `db.createPage(uuid(), req.body.name || "New Page", pages.length, …)` call's third argument from `pages.length` to `position`.

- [ ] **Step 7: Run the host suite**

Run: `cd host && npm test`
Expected: PASS.

- [ ] **Step 8: Smoke the frame against an isolated host**

Start a throwaway host (never the real DB, never port 9001 if it is occupied by the live host — use `PORT=9099`):

```bash
mkdir -p /e/temp/echodeck-test-home
USERPROFILE='E:\\temp\\echodeck-test-home' APPDATA='E:\\temp\\echodeck-test-home' \
  LOCALAPPDATA='E:\\temp\\echodeck-test-home' PORT=9099 node host/src/server.js &
sleep 2
curl -s localhost:9099/api/pages | head -c 400
```

Then from a second shell drive the ws frame with a short Node script using `ws` from `host/node_modules` (loopback needs no token): connect, send `{v:1,t:"reorder_pages",page_ids:["<second-id>","<first-id>"]}`, and assert the echoed `state` frame's `pages` array comes back in the new order; then send a bad batch (`page_ids:["nope"]`) and assert **no** further state frame arrives and the host log shows `[reorder_pages] rejected`. Kill the host and delete nothing else.

Expected: order flips on the good batch; the bad batch logs and stays silent.

- [ ] **Step 9: Commit**

```bash
git add host/src/server.js host/test/reorderPagesHandler.test.js
git commit -m "feat(host): accept reorder_pages and keep the hidden page out of page[0]"
```

---

### Task 4: Strip volume and mic rows from the phone control sheet

**Files:**
- Modify: `client/src/mobile/ControlSheet.jsx` — `SHEET_HOLD_STEP` `:31`, `LevelRow` `:67-224`, the two rows `:492-522`, the props block `:226-259`
- Modify: `client/src/App.jsx` — the `<ControlSheet>` props `:1984-2013`, `sendMuteToggle` `:1591-1599`, `sendVolumeSet` `:1608-1618`
- Delete: `client/src/mobile/volumeTap.js`, `client/test/controlSheetVolumeTap.test.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: a sheet whose only rows are stats, connection + disconnect, and the action buttons. `startVolumeHold`/`stopVolumeHold` **stay** (deck tiles call them at `App.jsx:1894-1895`).

- [ ] **Step 1: Confirm what is safe to delete**

Run: `grep -rn "volumeTap\|sliderSetArgs\|sendVolumeSet\|sendMuteToggle\|LevelRow\|SHEET_HOLD_STEP" client/src client/test`
Expected: hits only in `ControlSheet.jsx`, `App.jsx`, `volumeTap.js`, and `controlSheetVolumeTap.test.js`. If any other file appears, STOP and re-check before deleting — the shared-vs-dead split below assumes no other consumer.

- [ ] **Step 2: Delete the two rows and the shared row component**

In `ControlSheet.jsx`: remove the volume `<LevelRow>` (`:500-510`), the mic `<LevelRow>` (`:512-522`), the comment block that only explains their full-width spanning (`:492-499`), the `LevelRow` component (`:67-224`), `SHEET_HOLD_STEP` and its comment (`:28-31`), and the `import … from "./volumeTap.js"` line (`:22`).

- [ ] **Step 3: Drop the now-unused props**

In `ControlSheet.jsx:226-259`, delete `volume`, `muted`, `micVolume`, `micMuted`, `startVolumeHold`, `stopVolumeHold`, `sendMuteToggle`, `sendVolumeSet`. Keep `stats`, `isConnected`, `status`, `handleDisconnect`, `disconnectActive`, `setDisconnectActive`, `editModeApiRef`, `id`, `open`, `onClose` (and, until Task 5, the settings props).

In `App.jsx:1984-2013`, delete the eight matching props (`volume`, `muted`, `micVolume`, `micMuted`, `startVolumeHold`, `stopVolumeHold`, `sendMuteToggle`, `sendVolumeSet`).

- [ ] **Step 4: Delete the dead senders and their helper**

In `App.jsx`, delete `sendMuteToggle` (`:1591-1599`), `sendVolumeSet` (`:1608-1618`) and the explanatory comment above them (`:1587-1590`). **Do not touch** `startVolumeHold` (`:1570-1579`), `stopVolumeHold` (`:1582-1585`), `volumeStepFor`, `applyLevels`, or the `volume`/`muted`/`micVolume`/`micMuted` state (`:440-444`) — deck tiles, the handle's mic marker and the desktop all read them.

Delete `client/src/mobile/volumeTap.js` and `client/test/controlSheetVolumeTap.test.js` (the helper's only consumer is gone).

- [ ] **Step 5: Run tests and lint**

Run: `cd client && npm test` — expect PASS (one obsolete file removed, no other expectation changes).
Run: `cd client && npm run lint` — expect exit 0. **A `no-unused-vars` error here means a leftover prop or import; fix it rather than adding an ignore.**

- [ ] **Step 6: Manual check that deck volume/mic actions still work**

Run: `cd client && npm run dev` and open `http://localhost:5173/?mock=1`, tap the handle to open the sheet, and confirm in the browser console that (a) the sheet shows no Vol/Mic rows, (b) a volume action still exists in the action library, and (c) pressing a volume tile still sends `volume_hold_start`. Mock mode never reaches a host, so "sends" is verified by the `__MOCK_WS__.sent` array:

```js
window.__MOCK_WS__.sent.filter((f) => /volume/.test(f.t))
```

Expected: `[{v:1,t:"volume_hold_start",…}, …]` after a tile press, and zero `volume` rows rendered in the sheet.

- [ ] **Step 7: Commit**

```bash
git add -A client/src/mobile/ControlSheet.jsx client/src/App.jsx client/src/mobile/volumeTap.js client/test/controlSheetVolumeTap.test.js
git commit -m "refactor(mobile): drop volume and mic rows from the control sheet"
```

---

### Task 5: Move detailed layout settings to desktop only

**Files:**
- Modify: `client/src/mobile/ControlSheet.jsx` — Settings button `:613-634`, sub-panel `:639-671`, props `:245-258`, `settingsOpen` `:266`, Escape unwinding `:341-350`, swipe thief guard `:371-390`
- Modify: `client/src/App.jsx` — `<ControlSheet>` props `:2003-2012`, `handleLayoutSave` `:1081-1115`, `refreshPresets` `:1123-…`, preset save/apply/delete containers, `presets` state
- Untouched: `client/src/layout/LayoutSettingsForm.jsx` (desktop still renders it at `DesktopApp.jsx:2477`), `client/src/layout/layoutForm.js`, `client/src/layout/presetsClient.js` (desktop still imports them), the phone's read-only `GET /settings` effect (`App.jsx:791-808`)

**Interfaces:**
- Consumes: nothing new.
- Produces: the sheet's only action button is Edit Layout; the phone still *renders* the layout configured on desktop.

- [ ] **Step 1: Re-verify the desktop surface has parity before removing the phone's**

Open `DesktopApp.jsx:2477-2487` and `ControlSheet.jsx:656-669` side by side. Every prop the phone passes (`initialConfig`, `pageName`, `onSave`, `presets`, `onSavePreset`, `onApplyPreset`, `onDeletePreset`, `pageId`, `pageStoredConfig`) is passed by desktop, and desktop's `handleLayoutSave` (`:1157-1196`) covers both the `page` and global scopes. Record the check in the commit message body. **If desktop lacks a scope or the presets section, STOP — removing the phone's copy would then be a capability loss, not a duplicate removal.**

- [ ] **Step 2: Remove the door and the panel from the sheet**

In `ControlSheet.jsx`: delete the Settings `<button>` (`:613-634`) and its comment (`:610-612`), the whole `settingsOpen ? … : null` sub-panel (`:639-671`), the `settingsOpen` state (`:261-266`), the `LayoutSettingsForm` import (`:26`) and its comment (`:23-25`), and these props from the signature: `layoutConfig`, `pageName`, `onLayoutSave`, `onSettingsOpen`, `presets`, `onPresetSave`, `onPresetApply`, `onPresetDelete`, `layoutPageId`, `layoutPageStored`.

Change the action row so Edit Layout is the only button in it, and drop its `marginLeft: "auto"` (`:600`) since it no longer shares the row — keep the `Icon name="drag"` and the `editModeApiRef.current?.toggleEditMode(); onClose();` handler exactly as-is (`:598-608`).

- [ ] **Step 3: Simplify the sheet's input-dependent guards**

With no `input` and no `[data-layout-form]` left in the sheet:
- Escape (`:341-350`): delete the "close the settings panel first" step so Escape closes the sheet directly. Keep the focus-trap effect (`:352-369`) untouched.
- Up-swipe (`:371-390`): delete the thief test for `input`/`[data-layout-form]` (`:375-381`) and its comment (`:373-374`), so an upward swipe anywhere in the sheet dismisses it. Keep `swipeStartY` bookkeeping (`:309`, `:385-390`).

- [ ] **Step 4: Delete the phone's layout-config write container**

In `App.jsx`: delete the `<ControlSheet>` props `layoutConfig`, `pageName`, `onLayoutSave`, `onSettingsOpen`, `presets`, `onPresetSave`, `onPresetApply`, `onPresetDelete`, `layoutPageId`, `layoutPageStored` (`:2003-2012`); `handleLayoutSave` (`:1071-1115`); `refreshPresets` and the preset save/apply/delete callbacks with their comment blocks (`:1117` through the end of the preset-apply function, roughly `:1250`); and the `presets` state declaration.

**Keep:** the read-only `/settings` fetch (`App.jsx:791-808`) — it is how the phone renders a layout the desktop configured; `globalLayout` state; `layoutSettings`/`mergeLayout` (`:844-851`); `currentDeckPage` (`:856`) — still used by the hidden-page layout guard; `sheetPageName` (`:857-858`) becomes unused, so delete it too.

- [ ] **Step 5: Run tests, lint, and check for orphaned imports**

Run: `cd client && npm run lint` — expect exit 0; hunt any `no-unused-vars` for `mergeScopeConfig`, `listPresets`, `savePreset`, `deletePreset` and remove those imports **only if** `App.jsx` no longer references them (grep first: `grep -n "mergeScopeConfig\|presetsClient" client/src/App.jsx`).
Run: `cd client && npm test` — expect PASS.
Run: `cd client && npm run build` — expect success.

- [ ] **Step 6: Confirm the phone still paints a desktop-chosen layout**

In `?mock=1` dev mode, `GET /api/settings` is mocked to `{ layout_config: null }` (`deck.spec.ts:55`), so instead verify by hand in the built app's console that the engine still receives a merged config: open the phone deck and evaluate `document.querySelectorAll('[style*="grid-template-columns"]').length > 0`. Expected: non-zero, i.e. the layout path is still live after the panel is gone. Then run the viewport suite (Task 6 Step 2) as the real proof.

- [ ] **Step 7: Commit**

```bash
git add -A client/src
git commit -m "refactor(mobile): make detailed layout settings desktop-only

The phone's Settings door duplicated the desktop Layout Settings modal, which
already passes the same LayoutSettingsForm contract with both page and global
scopes plus presets. Detailed configuration now lives on desktop only."
```

---

### Task 6: Compact the sheet and fix the narrow-landscape flow

**Files:**
- Modify: `client/src/mobile/ControlSheet.jsx` — rows wrapper `:443-470`, section grid `:470-636`, `<style>` block `:673-684`, container cap `:428`
- Modify: `client/test/viewport/deck.spec.ts` — the Edit Layout helper fallback `:108-133`

**Interfaces:**
- Consumes: Task 4 and Task 5's trimmed sheet.
- Produces: the open sheet fits `min(55%, 220px)` with **no** clipping at every landscape viewport (`653×320`, `800×360`, `932×360`), and the deck still re-fits via ResizeObserver because the sheet remains push-down.

- [ ] **Step 1: Collapse the grid to one flow**

The 2-column flow only engaged under `max-width: 499px` (`:680-683`), i.e. never on landscape — which is what overflowed. Replace the `<style>` block (`:673-684`) with a single-column flex column and keep the class names that the remaining rows use:

```jsx
      <style>{`
        /* One flow for every viewport: the sheet now holds three short rows, so
           the narrow (<500px) two-column trick is no longer needed to fit the
           220-px cap — and it never applied to landscape anyway, which is what
           used to clip. */
        .deck-sheet-grid {
          display: flex;
          flex-direction: column;
          gap: 8px;
          align-items: stretch;
        }
      `}</style>
```

Then remove every `className="deck-sheet-span-all"` (the stats row `:475` and the connection row `:528`) and the `className="deck-sheet-grid"` comment about columns (`:492-499` was deleted in Task 4; re-check nothing references the class).

- [ ] **Step 2: Tighten the remaining rows**

Give the three rows a consistent rhythm: stats row `gap: 5` and the pills unchanged (fixed slot widths, so the clock never reflows); connection row `gap: 6`, both children already `height: 24` (`:536`, `:581`); action row's Edit Layout button `height: 24` to match. Reduce the wrapper's vertical padding to `"6px max(env(safe-area-inset-left), 16px) 8px max(env(safe-area-inset-right), 16px)"` (`:446` — keep the horizontal insets; the outer column at `App.jsx:1957-1960` owns the vertical safe area). Leave the cap at `min(55%, 220px)` (`:428`) — do **not** shrink it; landscape 320px-tall screens need the 55% clamp to keep the deck usable.

- [ ] **Step 3: Update the viewport spec's Edit Layout helper**

`deck.spec.ts:108-133` clicks the sheet's "Edit Layout" button and carries an explicit fallback "because the sheet's max-height cap clips it on the shortest landscape viewports". With the two rows gone the button is always reachable. Simplify the helper to: open the sheet, assert `#deck-control-sheet` is not `inert`, click `getByRole("button", { name: "Edit Layout" })`, and wait for the editor bar — then **delete the fallback branch and its comment**, since a fallback that cannot be reached is dead test code.

Run: `cd client && npm run test:viewport`
Expected: PASS across all viewports, including the three landscape entries. **If any landscape viewport now reports the Edit Layout button missing, the cap is still clipping — take a screenshot with `page.screenshot()` before changing production code.**

- [ ] **Step 4: Commit**

```bash
git add client/src/mobile/ControlSheet.jsx client/test/viewport/deck.spec.ts
git commit -m "feat(mobile): compact the control sheet for narrow landscape"
```

---

### Task 7: Page order in the Edit Layout draft (`layoutDraft.js`)

**Files:**
- Modify: `client/src/layout/layoutDraft.js` — `makeDraft` `:92-96`, `createDraft` `:111-143`, `resize` `:151`, `reorder` `:181`, `moveToPage` `:204`, new `shiftPage`, `diffDraft` `:218-273`, and the module header ops list (`:43-84`)
- Modify: `client/test/layoutDraft.test.js` — append page-order cases
- Modify: `client/src/layout/deckPages.js` — new `pagesInOrder` helper
- Modify: `client/test/deckPages.test.js` — append cases for it

**Interfaces:**
- Consumes: nothing new.
- Produces: `draft.pageOrder: string[]` (visible page ids, wanted order); `shiftPage(draft, pageId, delta) -> draft`; `diffDraft(base, draft).pageOrder: string[]` (`[]` = unchanged); `pagesInOrder(pages, order) -> page[]`. Task 8 consumes all four.

- [ ] **Step 1: Write the failing draft tests**

Append to `client/test/layoutDraft.test.js`, following its existing style (`// ---- helpers ----`, small `key()`/`pageKeys()` accessors, one contract restated per case):

```js
// ---- page order (final polish: page reordering is draft-scoped) ----

const ORDER = ["p1", "p2", "p3"];
const orderDraft = (items = [tile("button", 1, "p1", 0)]) =>
  createDraft(items, ORDER);

test("createDraft keeps the supplied visible page order verbatim", () => {
  assert.deepEqual(orderDraft().pageOrder, ["p1", "p2", "p3"]);
});

test("createDraft defaults to an empty page order and de-dupes junk input", () => {
  assert.deepEqual(createDraft([tile("button", 1, "p1", 0)]).pageOrder, []);
  assert.deepEqual(
    createDraft([], ["p1", "p1", 7, null, "p2"]).pageOrder,
    ["p1", "p2"],
  );
});

test("shiftPage moves a page one step and returns a new draft", () => {
  const d = orderDraft();
  const next = shiftPage(d, "p3", -1);
  assert.notEqual(next, d);
  assert.deepEqual(next.pageOrder, ["p1", "p3", "p2"]);
  assert.deepEqual(d.pageOrder, ["p1", "p2", "p3"]); // input untouched
});

test("shiftPage across several steps accumulates", () => {
  let d = orderDraft();
  d = shiftPage(d, "p3", -1);
  d = shiftPage(d, "p3", -1);
  assert.deepEqual(d.pageOrder, ["p3", "p1", "p2"]);
});

test("shiftPage at the ends and for unknown or absent pages returns the same draft reference", () => {
  const d = orderDraft();
  assert.equal(shiftPage(d, "p1", -1), d);
  assert.equal(shiftPage(d, "p3", 1), d);
  assert.equal(shiftPage(d, "nope", 1), d);
});

test("shiftPage preserves items, sizes and the unfiled marker", () => {
  let d = orderDraft([tile("button", 1, "p1", 0), tile("widget", 2, "p2", 0)]);
  d = detach(d, "widget:2", () => "__unfiled__");
  const moved = shiftPage(d, "p1", 1);
  assert.deepEqual(moved.pageOrder, ["p2", "p1", "p3"]);
  assert.equal(moved.unfiledPageId, "__unfiled__");
  assert.deepEqual(pageKeys(moved, "p1"), ["button:1"]);
});

test("item ops carry pageOrder forward unchanged", () => {
  const items = [tile("button", 1, "p1", 0), tile("button", 2, "p1", 1)];
  const d = createDraft(items, ORDER);
  assert.deepEqual(resize(d, "button:1", "2x1").pageOrder, ORDER);
  assert.deepEqual(moveToPage(d, "button:1", "p2").pageOrder, ORDER);
  assert.deepEqual(
    reorder(d, "button:1", "button:2").pageOrder,
    ORDER,
  );
});

test("diffDraft emits the new order only when it changed", () => {
  const base = orderDraft();
  assert.deepEqual(diffDraft(base, base).pageOrder, []);
  assert.deepEqual(diffDraft(base, shiftPage(base, "p3", -1)).pageOrder, [
    "p1",
    "p3",
    "p2",
  ]);
});

test("diffDraft emits nothing when the two orders differ in length", () => {
  // A page cannot be created or removed inside the item draft, so a length
  // mismatch means a caller mixed drafts from different sessions — and the host
  // would reject a partial batch anyway. Silence beats a guaranteed-rejected frame.
  const base = orderDraft();
  const odd = { ...base, pageOrder: ["p1", "p2"] };
  assert.deepEqual(diffDraft(base, odd).pageOrder, []);
});

test("diffDraft reports a page reorder independently of item changes", () => {
  const base = orderDraft([tile("button", 1, "p1", 0)]);
  const d = shiftPage(base, "p3", -2);
  const diff = diffDraft(base, d);
  assert.deepEqual(diff.pageOrder, ["p3", "p1", "p2"]);
  assert.deepEqual(diff.reordersByPage, {});
  assert.deepEqual(diff.sizePatches, []);
  assert.deepEqual(diff.moves, []);
});
```

Add `shiftPage` to the file's existing `import { … } from "../src/layout/layoutDraft.js"` statement.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd client && node --test test/layoutDraft.test.js`
Expected: FAIL — `shiftPage is not exported` / `pageOrder` undefined.

- [ ] **Step 3: Thread `pageOrder` through the model**

In `client/src/layout/layoutDraft.js`:

```js
function makeDraft(items, unfiledPageId, pageOrder) {
  const byId = {};
  for (const it of items) byId[it.key] = it;
  return { items, byId, unfiledPageId, pageOrder: normalizeOrder(pageOrder) };
}

// Visible page ids, de-duped, strings only. Order is the caller's business: it
// comes from visibleDeckPages(pages) at draft-entry and only shiftPage changes
// it, so a hidden page (the lazy Unfiled bucket) can never enter it.
function normalizeOrder(pageOrder) {
  if (!Array.isArray(pageOrder)) return [];
  const seen = new Set();
  const out = [];
  for (const id of pageOrder) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
```

Change `createDraft(deckItems)` → `createDraft(deckItems, pageOrder = [])` and its final line to `return makeDraft(items, undefined, pageOrder);`. Update the three other `makeDraft(items, draft.unfiledPageId)` calls (`resize`, `reorder`, `moveToPage`) to `makeDraft(items, draft.unfiledPageId, draft.pageOrder)`. `detach` returns `{ ...next, unfiledPageId }` — no change needed, `next` already carries the order.

- [ ] **Step 4: Add `shiftPage`**

Insert after `reorder` (ends at `:182`):

```js
/**
 * Page reordering: shift one VISIBLE page by `delta` (±1) within the draft's
 * page order. This is the touch-safe alternative to dragging — the phone offers
 * Move earlier / Move later — and it changes nothing about the items, so it
 * composes freely with reorder/moveToPage/detach in one session. Unknown ids
 * and moves past either end are no-ops returning the SAME draft, so a disabled
 * button firing anyway cannot dirty the toolbar.
 */
export function shiftPage(draft, pageId, delta) {
  const order = draft.pageOrder;
  const from = order.indexOf(pageId);
  if (from < 0) return draft;
  const to = from + (Number.isInteger(delta) ? delta : 0);
  if (to < 0 || to >= order.length) return draft;
  return makeDraft(draft.items, draft.unfiledPageId, arrayMove(order, from, to));
}
```

- [ ] **Step 5: Emit it from `diffDraft`**

Add before the `return` of `diffDraft` (`:272`):

```js
  // Page order is a separate, independent axis from item order: it reports when
  // the two visible lists differ at the same length. A length mismatch means the
  // caller mixed drafts from different sessions and the host would reject a
  // partial batch, so it reports nothing rather than a guaranteed rejection.
  const wasOrder = base.pageOrder ?? [];
  const nowOrder = draft.pageOrder ?? [];
  const pageOrder =
    wasOrder.length === nowOrder.length &&
    wasOrder.length > 1 &&
    nowOrder.some((id, i) => id !== wasOrder[i])
      ? nowOrder
      : [];
```

and change the return to `return { reordersByPage, sizePatches, moves, detachments, pageOrder };`.

- [ ] **Step 6: Update the module header**

In the ops list (`:43-84`), add under `detach`:

```
 * shiftPage(draft, pageId, delta)
 *   Page reordering (final polish). Moves one VISIBLE page ±1 place in
 *   `draft.pageOrder` — a list the draft receives from the caller
 *   (visibleDeckPages(pages)) and never derives from item rows, so a hidden page
 *   cannot sneak into a reorder batch. Item ops leave it untouched.
```

and update the `diffDraft` line to `-> { reordersByPage, sizePatches, moves, detachments, pageOrder }` plus a note: `pageOrder: string[] — the new visible id order when it changed, [] otherwise.`

- [ ] **Step 7: Run the draft tests**

Run: `cd client && node --test test/layoutDraft.test.js`
Expected: PASS (existing 22 + new 11).

- [ ] **Step 8: Write the failing `pagesInOrder` tests**

Append to `client/test/deckPages.test.js`:

```js
// pagesInOrder: re-sort the visible page list by a draft's order without ever
// inventing or dropping a page. Pure module, `node --test`, no DOM.
import { pagesInOrder } from "../src/layout/deckPages.js";

test("pagesInOrder returns the listed order, preserving object identity", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const out = pagesInOrder([a, b], ["b", "a"]);
  assert.deepEqual(out.map((p) => p.id), ["b", "a"]);
  assert.equal(out[0], b);
});

test("pagesInOrder keeps an order-less list as-is", () => {
  const a = { id: "a" };
  assert.deepEqual(pagesInOrder([a], []), [a]);
  assert.deepEqual(pagesInOrder([a], null), [a]);
});

test("pagesInOrder trails pages the order does not mention, in their own order", () => {
  // A page created after the draft was seeded is new to the order list; it must
  // still render rather than vanish from the pager.
  const out = pagesInOrder(
    [{ id: "a" }, { id: "b" }, { id: "c" }],
    ["c", "a"],
  );
  assert.deepEqual(out.map((p) => p.id), ["c", "a", "b"]);
});

test("pagesInOrder drops ids the page list does not contain", () => {
  const out = pagesInOrder([{ id: "a" }], ["ghost", "a"]);
  assert.deepEqual(out.map((p) => p.id), ["a"]);
});

test("pagesInOrder survives null input", () => {
  assert.deepEqual(pagesInOrder(null, ["a"]), []);
});
```

(Keep the file's single `import` line style — merge `pagesInOrder` into the existing import from `deckPages.js` rather than adding a second one if the file already imports from it.)

- [ ] **Step 9: Run to verify failure, then implement**

Run: `cd client && node --test test/deckPages.test.js` → FAIL (`pagesInOrder is not exported`).
Then append to `client/src/layout/deckPages.js`:

```js
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
```

Run: `cd client && node --test test/deckPages.test.js` → PASS.
Run: `cd client && npm test && npm run lint` → PASS, exit 0.

- [ ] **Step 10: Commit**

```bash
git add client/src/layout/layoutDraft.js client/src/layout/deckPages.js client/test/layoutDraft.test.js client/test/deckPages.test.js
git commit -m "feat(client): carry page order in the layout draft"
```

---

### Task 8: Mobile page reordering in the Edit Layout toolbar

**Files:**
- Modify: `client/src/mobile/DeckEditorBar.jsx` — props `:92-104`, `ToolButton` `:63-86`, new deck-level group + Pages disclosure before `:140`
- Modify: `client/src/App.jsx` — `createDraft` call sites `:192`, `:236`, `:882`, `:1286`; `dirty` `:959-968`; new `handleShiftPage`; `handleSave` `:1398-1505`; `<DeckEditorBar>` props `:2158-2170`; pager dots `:2096-2145` via a draft-ordered memo
- Modify: `client/test/viewport/deck.spec.ts`, `client/src/mock/fixtures/deck.json`

**Interfaces:**
- Consumes: `shiftPage`, `diffDraft().pageOrder`, `pagesInOrder` (Task 7); `reorder_pages` frame (Task 3).
- Produces: a `Pages ▸` disclosure with Earlier/Later per visible page; a Save that emits one `reorder_pages` frame after the item batches.

- [ ] **Step 1: Let the toolbar's `ToolButton` be disabled**

`ToolButton` (`DeckEditorBar.jsx:63-86`) takes no `disabled`. Add it, mirroring `SegmentButton`'s treatment (`:31-61`): `disabled` in the destructure, `disabled={disabled}` on the `<button>`, `cursor: disabled ? "default" : "pointer"`, `opacity: disabled ? 0.4 : 1`, and a `color: disabled ? "#43434d" : "#c9c9d4"`.

- [ ] **Step 2: Add the Pages disclosure**

New props on `DeckEditorBar`: `orderedPages = []` (the visible pages in draft order) and `onShiftPage = null`. New state beside `moveOpen` (`:105`): `const [pagesOpen, setPagesOpen] = useState(false);`. Then insert a deck-level group **before** the `{selected && id && (…)}` block (`:140`) — it must render even with no tile selected, because page order is not a per-item edit:

```jsx
      {/* FEATURE: Page reordering — a deck-level control, so it renders with no
          tile selected. Order is part of the draft: these taps move a page inside
          draft.pageOrder and nothing reaches the host until Save, exactly like a
          tile drag. Move earlier / Move later rather than dragging, because the
          dots are 7 px tall and this is the touch surface. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <ToolButton
          label="Pages ▸"
          active={pagesOpen}
          onClick={() => setPagesOpen((o) => !o)}
        />
      </div>

      {pagesOpen && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            width: "100%",
            padding: "6px 8px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(255,255,255,0.03)",
            boxSizing: "border-box",
          }}
        >
          {orderedPages.length <= 1 && (
            <span style={{ fontSize: 11, color: "#55555f" }}>
              Only one page
            </span>
          )}
          {orderedPages.map((p, i) => (
            <div
              key={p.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                minWidth: 0,
              }}
            >
              <span
                aria-current={p.id === currentPage ? "true" : undefined}
                style={{
                  flex: "1 1 auto",
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: 12,
                  fontWeight: 600,
                  // The active page has to stay obvious while reordering, and the
                  // dots are too subtle on this surface.
                  color: p.id === currentPage ? "#eaf3fb" : "#9a9aa6",
                }}
              >
                {i + 1}. {p.name || "Page"}
              </span>
              <ToolButton
                label="Earlier"
                disabled={i === 0}
                onClick={() => onShiftPage?.(p.id, -1)}
              />
              <ToolButton
                label="Later"
                disabled={i === orderedPages.length - 1}
                onClick={() => onShiftPage?.(p.id, 1)}
              />
            </div>
          ))}
        </div>
      )}
```

Also close the disclosure whenever the selection changes page (mirror `closeMove()`'s role): nothing required beyond leaving it open — it is deck-level, so keep it simple and do not couple it to `moveOpen`.

- [ ] **Step 3: Give the draft its page order at every seed site**

`App.jsx`: `:882` and `:1286` become `createDraft(deckItems, visiblePages.map((p) => p.id))` (add `visiblePages` to both `useCallback` dep arrays — `:888`, `:1293`). `:192` `foldPageIntoDraft` and `:236` `reseedPageFromServer` become `createDraft([...], draft.pageOrder)` — both are module-scope arrow functions already receiving `draft`, so pass the order through:

```js
const foldPageIntoDraft = (draft, pageId, serverRows) =>
  draftHasPage(draft, pageId)
    ? draft
    : createDraft([...draft.items, ...serverRows], draft.pageOrder);
```

```js
const reseedPageFromServer = (draft, pageId, serverItems) => {
  if (!draft) return draft;
  return createDraft(
    [
      ...draft.items.filter((it) => it.page_id !== pageId),
      ...serverItems,
    ],
    draft.pageOrder,
  );
};
```

- [ ] **Step 4: Wire the handler and the dirty gate**

Add beside `handleResize`/`handleMoveToPage` (`:1302-1370`):

```js
  // FEATURE: Page reordering — no foldPageIntoDraft here: page order lives on
  // its own axis from the item rows, so it needs neither the viewed page's rows
  // nor a selection. The draft is the only place it changes.
  const handleShiftPage = useCallback(
    (pageId, delta) => {
      if (!draft) return;
      const next = shiftPage(draft, pageId, delta);
      if (next !== draft) setDraft(next);
    },
    [draft],
  );
```

Add `shiftPage` to the `layoutDraft.js` import in `App.jsx`, and extend the `dirty` memo (`:959-968`) with `|| diff.pageOrder.length > 0`.

- [ ] **Step 5: Emit the frame from Save, last**

In `handleSave`, extend the early "nothing to save" guard (`:1401-1408`) to consider order:

```js
    const hasPageOrder = diff.pageOrder.length > 0;
    if (
      !reorderKeys.length &&
      !hasMoves &&
      !hasDetaches &&
      !hasSizes &&
      !hasPageOrder
    ) {
      showToast("Nothing to save");
      return;
    }
```

and append after the `reorder_items` loop (which ends at `:1505`):

```js
      // (e) Page order LAST. One frame for the whole deck, and it only ever
      // carries visible pages — a Unfiled page materialized in (a) is hidden, so
      // the host pins it to the tail itself and the batch stays valid either way.
      if (hasPageOrder) {
        socket.send(
          JSON.stringify({
            v: 1,
            t: "reorder_pages",
            page_ids: diff.pageOrder,
          }),
        );
      }
```

- [ ] **Step 6: Paint the dots in draft order while editing**

Add a memo after `visiblePages` (`:860`) — `import { pagesInOrder, visibleDeckPages } from "./layout/deckPages.js"`:

```js
  // FEATURE: Page reordering — the pager reflects the draft's order while editing,
  // so a Move earlier / Move later tap shows up immediately on the dots. Outside
  // edit mode this is `visiblePages` unchanged (the draft is null), so normal
  // navigation keeps reading the host's authoritative order.
  const pagerPages = useMemo(
    () =>
      editMode && draft
        ? pagesInOrder(visiblePages, draft.pageOrder)
        : visiblePages,
    [editMode, draft, visiblePages],
  );
```

Use `pagerPages` for the dots gate and map (`:2098`, `:2109`). **Leave `switchPage`, `currentDeckPage`, `handleSave`'s `known` set and the deck-swipe handler on `visiblePages`** — swipe is suppressed in edit mode anyway, and the swipe handler's `findIndex`/modulo must keep tracking the host's truth.

- [ ] **Step 7: Pass the toolbar props**

`<DeckEditorBar>` (`:2158-2170`) gains `orderedPages={pagerPages}` and `onShiftPage={handleShiftPage}`.

- [ ] **Step 8: Extend the viewport fixture and spec**

`client/src/mock/fixtures/deck.json` `pages` array (`:4-7`): give each page an explicit `position` and add a third page so a reorder has room to move (the dots and the Pages list need ≥2 visible pages, and `position` documents what the host actually sends):

```json
    "pages": [
      { "id": "page_main", "name": "Main", "position": 0, "show_labels": 1 },
      { "id": "page_two", "name": "Second", "position": 1, "show_labels": 1 },
      { "id": "page_hidden", "name": "Unfiled", "position": 2, "show_labels": 0, "hidden": true }
    ],
```

Adding the hidden page also proves the D3 exclusion in the new test. `client/test/viewport/deck.spec.ts`: append a seventh numbered test after test 6, following its frame-assertion style (`mockSentFrames` at `:135-139`, `f.v === 1` check):

```ts
  test("7. pages: the Unfiled page stays out of navigation, and a move emits reorder_pages", async ({
    page,
  }) => {
    const { captured, fixture } = await openMockDeck(page);

    // D3 still holds after reordering landed: a hidden page never reaches the
    // dots. Counted rather than eyeballed, because the fixture now has three
    // pages and only two are visible.
    const dotCount = await page
      .locator('[aria-label="Main"], [aria-label="Second"], [aria-label="Unfiled"]')
      .count();
    expect(dotCount, "Unfiled stays absent from the pager").toBe(2);

    await enterEditMode(page);
    const pagesBtn = page.getByRole("button", { name: "Pages ▸", exact: true });
    await expect(pagesBtn, "toolbar offers page order").toBeVisible();
    await pagesBtn.click();

    // The active page is labelled, and the first page's "Earlier" is disabled at
    // the end of the list — the two facts that make this surface verifiable.
    const earlier = page.getByRole("button", { name: "Earlier", exact: true });
    await expect(earlier.first()).toBeDisabled();
    const later = page.getByRole("button", { name: "Later", exact: true });
    await expect(later.last()).toBeDisabled();

    await later.first().click(); // Main -> position 2
    await earlier.last().click(); // Second back to the front
    await page.getByRole("button", { name: "Save", exact: true }).click();

    const frames = captured.sent.filter((f) => f.t === "reorder_pages");
    expect(frames.length, "one page-order frame per Save").toBe(1);
    expect(frames[0].v).toBe(1);
    expect(frames[0].page_ids).toEqual(["page_two", "page_main"]);
    expect(
      frames[0].page_ids.includes("page_hidden"),
      "a hidden page is never part of the batch",
    ).toBe(false);
  });
```

(`captured.sent` shape per `mockSocket.js:45-47`; adapt to the fixture's real second-page id if it differs — read `deck.json` before running.)

- [ ] **Step 9: Run the full client gate**

Run: `cd client && npm test` → PASS.
Run: `cd client && npm run lint` → exit 0.
Run: `cd client && npm run build` → success.
Run: `cd client && npm run test:viewport` → PASS, including test 7.

If test 7's frame assertions fail, dump `captured.sent` in the test to see what Save actually emitted before touching production code — the two clicks may fold differently than the draft assumes.

- [ ] **Step 10: Verify Discard really does revert**

Still in the viewport run, add a temporary throwaway assertion (or run the built app under `?mock=1` by hand): enter edit mode, click Later on the first page, click **Done**, then re-enter edit mode and confirm the Pages list shows the original order and no `reorder_pages` frame was ever sent. **This is the owner's explicit requirement — Discard restores the original page order — so it must be observed, not assumed.** Remove the temporary assertion afterwards.

- [ ] **Step 11: Commit**

```bash
git add client/src/App.jsx client/src/mobile/DeckEditorBar.jsx client/src/mock/fixtures/deck.json client/test/viewport/deck.spec.ts
git commit -m "feat(mobile): reorder pages from the edit layout toolbar"
```

---

### Task 9: Desktop widget drag affordances, drag-cancel, keyboard sensor

**Files:**
- Modify: `client/src/desktop/DesktopApp.jsx` — `globalStyles` `:166+`, sensors `:468-470`, `DndContext` `:1655-1660`, `handleDragEnd` `:1466`, `DesktopSortableWidget` `:3895-3950` and its call site `:1756-1767`

**Interfaces:**
- Consumes: nothing new (`useSortable` already exposes `isOver`; `@dnd-kit/sortable@10` exports `sortableKeyboardCoordinates`, verified in `node_modules/@dnd-kit/sortable/dist/index.d.ts:6`).
- Produces: widgets read as grabbable, drop onto them is highlighted like buttons, a cancelled drag clears state, and a keyboard user can move a focused tile.

- [ ] **Step 1: Add the hover/grip CSS**

Append to the `globalStyles` template (`DesktopApp.jsx:166`, injected at `:1633`) so hover works from an inline-styled component:

```css
  /* FEATURE: Page reordering / widget affordance — a tile that can be dragged
     says so. Inline styles cannot express :hover, so the affordance lives here
     and the tile carries the class. */
  .deck-tile-draggable:hover .tile-grip,
  .deck-tile-draggable:focus-visible .tile-grip { opacity: 0.85; }
  .deck-tile-draggable:hover { cursor: grab; }
  .tile-grip { transition: opacity 140ms var(--ease-out); }
```

- [ ] **Step 2: Register `KeyboardSensor`**

`import { DndContext, KeyboardSensor, PointerSensor, pointerWithin, closestCenter, DragOverlay, useSensor, useSensors, … }` — add `KeyboardSensor` to the `@dnd-kit/core` import (`:23-33`) and `sortableKeyboardCoordinates` to the `@dnd-kit/sortable` import (`:34-39`). Then:

```js
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    // FEATURE: Accessible move — useSortable already puts role/tabIndex/
    // aria-roledescription="sortable" on every tile, but with only a pointer
    // sensor those attributes were dead weight. Space/Enter grabs, arrows move.
    // sortableKeyboardCoordinates keeps the movement grid-aware, so a 2-wide
    // tile still steps like the pointer does.
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
```

- [ ] **Step 3: Add `onDragCancel`**

`activeId` is cleared only inside `handleDragEnd` (`:1466`), so Escape / pointer-cancel / window-blur leaves `activeAction` and `droppingAction` (`:1560-1575`, consumed at `:1749`) stuck and every affordance below misreports. Add beside `handleDragStart` (`:1460-1462`):

```js
  const handleDragCancel = useCallback(() => {
    // A cancelled drag never reaches handleDragEnd, and a stale activeId keeps
    // the drop-target rings lit on every tile — the reason a drag looked broken
    // rather than merely unfinished.
    setActiveId(null);
  }, []);
```

and wire `onDragCancel={handleDragCancel}` on the `DndContext` (`:1655-1660`).

- [ ] **Step 4: Give widget tiles the button's feedback plus a grip**

`DesktopSortableWidget` (`:3895-3950`): destructure `isOver` too (`:3906-3912`), accept a `droppingAction` prop, and mirror `DesktopSortableButton`'s ring (`:3833`, `:3848-3852`). Rewrite the wrapper's `style`/`className` and add the grip inside the wrapper:

```js
  const isDropTarget = isOver && droppingAction;
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="deck-tile-draggable"
      style={{
        position: "relative",
        gridColumn: `${placeCol + 1} / span ${placeCols}`,
        gridRow: `${placeRow + 1} / span ${placeRows}`,
        minWidth: 0,
        minHeight: 0,
        transform: CSS.Transform.toString(transform),
        zIndex: isDragging ? 999 : "auto",
        // Hide the source rather than dim it: the DragOverlay already draws this
        // tile (activeWidget, :1580) and a 0.3 ghost under the finger reads as a
        // tile that refused to move.
        opacity: isDragging ? 0 : 1,
        borderRadius: 8,
        // Longhands, not the `outline` shorthand — see DesktopSortableButton's
        // note on pending-substitution values in inline shorthand.
        outlineStyle: "solid",
        outlineWidth: 2,
        outlineColor:
          isDropTarget || selected ? "var(--accent)" : "transparent",
        outlineOffset: 2,
        boxShadow: isDropTarget ? "0 0 0 6px rgba(59,130,246,0.20)" : "none",
        transition: [
          transition,
          "outline-color 140ms var(--ease-out)",
          "box-shadow 140ms var(--ease-out)",
        ]
          .filter(Boolean)
          .join(", "),
      }}
      onClick={(e) => {
        if (!isDragging) {
          e.stopPropagation();
          onSelect(widget);
        }
      }}
    >
      {/* The tile is its own drag handle, so the grip marks the whole surface as
          grabbable instead of being a separate handle. */}
      <span
        aria-hidden="true"
        className="tile-grip"
        style={{
          position: "absolute",
          top: 4,
          right: 5,
          opacity: 0,
          fontSize: 10,
          lineHeight: 1,
          color: "#6b6b78",
          pointerEvents: "none",
          zIndex: 2,
        }}
      >
        <Icon name="drag" size={10} />
      </span>
      <WidgetTile …unchanged… >
        <SystemMonitorWidget widget={widget} data={data} />
      </WidgetTile>
    </div>
  );
```

Keep `selected` → ring so a keyboard-focused/selected tile shows the same accent a button does. Then pass `droppingAction={!!activeAction}` at the call site (`:1756-1767`), matching the button's prop at `:1749`.

- [ ] **Step 5: Run the client gate**

Run: `cd client && npm run lint && npm test && npm run build` — expect exit 0, PASS, success. (No unit test can reach this JSX; the Electron pass in Task 12 is the verification.)

- [ ] **Step 6: Commit**

```bash
git add client/src/desktop/DesktopApp.jsx
git commit -m "feat(desktop): make widget tiles read as draggable"
```

---

### Task 10: Desktop page-rail drag

**Files:**
- Modify: `client/src/desktop/DesktopApp.jsx` — sortable imports `:34-39`, new `PAGE_RAIL_PREFIX`/`pageSortableId` near `tileSortKey` `:125-133`, `PageRail` `:3371-3402` + `PageRailPill`, `pageReorderTimer` ref near `:324` + unmount cleanup `:563-566`, `handleDragEnd` before `:1512`, `<PageRail>` call site `:1826-1837`, `addPage` `:918`, `deletePage` `:939`, `styles.pagePill` `:5696-5715`

**Interfaces:**
- Consumes: `reorder_pages` (Task 3), `visiblePages` memo (`:435`), `setPages` (already used at `:1173`).
- Produces: a rail drag sends one debounced `reorder_pages` frame and repaints optimistically.

- [ ] **Step 1: Import the horizontal strategy**

Add `horizontalListSortingStrategy` to the `@dnd-kit/sortable` import (`:34-39`).

- [ ] **Step 2: Namespace the rail's sortable ids**

Beside `WIDGET_TILE_PREFIX` (`:130`) and `tileSortKey` (`:131-133`):

```js
// Page pills share the deck's DndContext, so their ids need a prefix of their own
// — a raw page id would collide with nothing today but reads as a deck item to
// handleDragEnd's router, and `page:` is unambiguous for both.
const PAGE_RAIL_PREFIX = "page:";
const pageSortableId = (id) => `${PAGE_RAIL_PREFIX}${id}`;
```

- [ ] **Step 3: Make the pills sortable**

Replace `PageRail` (`:3371-3402`) with a per-pill component (hooks cannot run in a loop) plus a `SortableContext` that wraps only the pills:

```js
const PageRailPill = memo(function PageRailPill({
  page,
  index,
  active,
  disabled,
  onSelect,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: pageSortableId(page.id), disabled });

  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className="deck-tile-draggable"
      style={{
        ...styles.pagePill,
        ...(active ? styles.pagePillActive : {}),
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0 : 1,
        zIndex: isDragging ? 999 : "auto",
        outlineStyle: "solid",
        outlineWidth: 2,
        outlineColor: isOver ? "var(--accent)" : "transparent",
        outlineOffset: 1,
      }}
      onClick={() => {
        if (!isDragging) onSelect(page.id);
      }}
      // The pill's label is a positional number, so the accessible name carries
      // the real name and where it sits — that is what makes a keyboard move
      // comprehensible.
      aria-label={`${page.name || "Page"} — position ${index + 1}`}
      aria-current={active}
      title={page.name}
    >
      {index + 1}
    </button>
  );
});

/** Profile pills under the canvas — the fast switch, and the drag handle for
 *  page order (final polish). Hidden pages are already filtered out by the
 *  caller, so Unfiled is never a reorder target. */
const PageRail = memo(function PageRail({
  pages,
  currentPage,
  onSelectPage,
  onAddPage,
}) {
  const ids = pages.map((p) => pageSortableId(p.id));
  return (
    <div style={styles.pageRail}>
      <SortableContext
        items={ids}
        strategy={horizontalListSortingStrategy}
      >
        {pages.map((p, i) => (
          <PageRailPill
            key={p.id}
            page={p}
            index={i}
            active={p.id === currentPage}
            disabled={pages.length < 2}
            onSelect={onSelectPage}
          />
        ))}
      </SortableContext>
      <button
        style={styles.pagePill}
        onClick={onAddPage}
        aria-label="New profile"
      >
        <Icon name="add" size={13} />
      </button>
    </div>
  );
});
```

`styles.pagePill` keeps `minWidth: 30 / height: 26`; bump `height` to 28 and add `cursor: "grab"`-adjacent polish only if the hover rule from Task 9 makes the pills feel right in the Electron pass.

- [ ] **Step 4: Handle the rail's drops**

Insert **before** the tile-reorder branch (`DesktopApp.jsx:1512`) inside `handleDragEnd`:

```js
      // Page pills ride the deck's own DndContext, so their drops land here too.
      // Order changes optimistically and the debounced reorder_pages echo (or a
      // later state frame) is the truth — the same contract as a tile drag.
      if (dragged.startsWith(PAGE_RAIL_PREFIX)) {
        const from = visiblePages.findIndex(
          (p) => pageSortableId(p.id) === dragged,
        );
        const to = visiblePages.findIndex(
          (p) => pageSortableId(p.id) === String(over.id),
        );
        if (from < 0 || to < 0 || from === to) return;
        const reordered = arrayMove(visiblePages, from, to);
        // Hidden pages are not in the rail, so they must not be dropped: they
        // trail, which mirrors the host pinning them behind the visible block.
        setPages([...reordered, ...pages.filter((p) => p.hidden)]);
        clearTimeout(pageReorderTimer.current);
        pageReorderTimer.current = setTimeout(() => {
          wsRef.current?.send(
            JSON.stringify({
              v: 1,
              t: "reorder_pages",
              page_ids: reordered.map((p) => p.id),
            }),
          );
        }, 300);
        return;
      }
```

Add `visiblePages` and `pages` to that `useCallback`'s dependency array (`:1547`) and declare the ref beside `reorderTimer` (`:324`):

```js
  // Separate timers: an item reorder and a page reorder must never cancel each
  // other out, and both debounce against a 300 ms window.
  const pageReorderTimer = useRef(null);
```

- [ ] **Step 5: Clean both timers up on unmount**

Extend the boot effect's cleanup (`:563-566`, which today clears `captureTimerRef` and `devicesInterval`) with:

```js
      clearTimeout(reorderTimer.current);
      clearTimeout(pageReorderTimer.current);
```

so a drop landing inside the 300 ms window of an unmount cannot fire into a stale closure.

- [ ] **Step 6: Fix the two page-order assumptions in desktop page CRUD**

`addPage` (`:918`) currently trusts `data[data.length - 1]` to be the new page — false once a hidden page is pinned last. Use the `POST /api/pages` response, which already returns `toDeckPage(page)` (`server.js:381`):

```js
      // The response is the new page, not "whichever row sorted last" — with a
      // hidden Unfiled page pinned to the tail, the created page is no longer the
      // array's final element.
      const created = await res.json();
      if (created?.id) switchPage(created.id);
```

`deletePage` (`:939`) falls back to `data[0]?.id`; make it the first visible page and keep it honest when the deleted page is the only one:

```js
        const first = data.find((p) => !p.hidden) ?? data[0];
        setCurrentPage(first?.id ?? null);
```

Adapt the surrounding code to whatever `res`/`data` names those functions already use — read `:905-942` before editing.

- [ ] **Step 7: Run the client gate**

Run: `cd client && npm run lint && npm test && npm run build` — expect exit 0, PASS, success.

- [ ] **Step 8: Commit**

```bash
git add client/src/desktop/DesktopApp.jsx
git commit -m "feat(desktop): drag page pills to reorder profiles"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/layout-model.md` (387 lines; the D2 ordering section is at `:170-211`)
- Modify: `README.md` (feature list around `:506`)

**Interfaces:**
- Consumes: everything above.
- Produces: a written ordering model that covers pages, the phone/desktop split, and the honest device-coverage record.

- [ ] **Step 1: Add a page-order section to `docs/layout-model.md`**

After the D2 section, add a section titled `## Page order (final polish)` documenting: `pages.position` is the order key and pre-dates this work (no migration was needed); `getPages()` orders `position, rowid`; `reorder_pages {page_ids}` is **visible-only** and the host pins hidden pages behind it, which is what keeps `pages[0]` navigable; `position` remains PATCH-writable per page (`PAGE_FIELDS`) but a single-page write is non-atomic, so the ws frame is the sanctioned path; on mobile page order is **draft-scoped** (Save commits, Done discards) while on desktop it commits immediately, because the desktop canvas has no draft — the same asymmetry as tile drag; and reordering never rewrites page `id`, `name`, `show_labels`, `hidden`, `layout_config`, item `page_id`/`slot`, or `profile_rules` (rules bind by `page_id` and rank by `priority`, independent of page order).

- [ ] **Step 2: Update the phone/desktop split and the README feature list**

In `docs/layout-model.md`, state the split the owner set: the phone sheet is status + disconnect + Edit Layout; detailed layout settings and presets are desktop-only; volume/mic are deck actions, not sheet controls (and hold-repeat lives in the host). In `README.md`, extend the drag line to `Drag-to-reorder buttons and widgets` and add `Reorder pages (desktop rail drag; mobile Edit Layout → Pages)`.

- [ ] **Step 3: Commit**

```bash
git add docs/layout-model.md README.md
git commit -m "docs: record page ordering and the phone/desktop configuration split"
```

---

### Task 12: Full verification matrix and device pass

**Files:** none (verification + report only).

- [ ] **Step 1: Automated gates on the final tree**

```bash
cd client && npm test && npm run lint && npm run build
cd host && npm test
```
Record exact counts. Baseline before this plan was client 500/500, host 135/135, lint exit 0 — expect client ≈ 500 − (deleted volumeTap cases) + (new page-order cases), host 135 + 20.

- [ ] **Step 2: Viewport matrix**

Run: `cd client && npm run test:viewport`
Expected: PASS over all viewports, including `compact-phone-landscape 653×320`, `phone-landscape 800×360`, `phone-landscape-large 932×360`, and the new test 7. Report per-viewport results; never summarise as "matrix green" if a viewport was skipped.

- [ ] **Step 3: Live host regression (the real pairing path, non-destructive)**

The dev host binds `0.0.0.0:9001`. Start the **modified** host against the throwaway home only if port 9001 is free; otherwise use `PORT=9099`. Confirm `GET /api/pages` still returns pages in `position` order, then drive a real `reorder_pages` over ws and read the order back after a restart of that isolated host (same temp DB) to prove persistence. **Never write to the real `macro-deck.db`.**

- [ ] **Step 4: Android build + install**

```bash
pwsh -File build-android.ps1 -Version 2.4.0
```
(Use `pwsh`, not `powershell.exe` — 5.1 mis-decodes the UTF-8 box-drawing lines at `build-android.ps1:43-45` and fails with a bogus "string is missing the terminator".)
Then `adb -s R9HN6024DJJ install -r echodeck-2.4.0.apk` and launch.

- [ ] **Step 5: Device verification on the Galaxy A11**

Check each and screenshot it: (a) the pull-down sheet shows CPU/RAM/clock, connection pill, disconnect and Edit Layout only — no Vol/Mic rows, no Settings button; (b) the sheet fits landscape without clipping — rotate to landscape and confirm the Edit Layout button is visible un-scrolled; (c) a **volume deck button** still changes host volume and its press-and-hold still repeats (the host interval, `server.js:1061-1112`, is what must still tick); (d) a mic button still toggles mute and the handle's mic marker reflects it; (e) Edit Layout: drag a tile, then Pages ▸ → Earlier/Later, watch the dots reorder live, Save, and confirm the host's `GET /api/pages` order changed; (f) enter Edit Layout, move a page, press **Done** — the order must revert; (g) Unfiled still absent from the dots while detached items stay recoverable via the move sheet; (h) layout presets/custom columns are no longer reachable on the phone but still are on desktop.
For (c)/(d) the CDP route is `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>` with the reusable `E:\temp\echodeck-test-home\cdp-eval.js` (`NODE_PATH` pointed at `host/node_modules`); re-read the PID after any app restart, and remove the forward when done.

- [ ] **Step 6: Electron desktop pass**

Rebuild the native dep for Electron's ABI first if the client dep install touched it (`npx electron-rebuild -f -w better-sqlite3`). Start the desktop app and verify: widgets and buttons interleave by drag and **survive a restart**; a widget tile shows the grip on hover and the accent ring when selected; dragging an action over a widget highlights it; Escape mid-drag leaves no stuck highlight; **Tab to a tile → Space → arrows → Space** moves it without touching the pointer; a library action/app/widget drop still works; a rail pill drag reorders pages, the phone's dots follow within a second, and the new order survives a host restart; the "New profile" flow still switches to the created page and the delete flow lands on a visible page.
Screenshots via CDP page-level `Emulation.setDeviceMetricsOverride` (`Browser.getWindowForTarget` is unsupported on Electron).

- [ ] **Step 7: Write the honest report**

Enumerate: every root change per task, the exact test/lint/build/viewport counts actually observed, the device and Electron observations actually performed, and explicitly separate *automated viewport coverage* from *physical device verification*. Name the gaps that remain — desktop drag has no automated test (dnd-kit does not activate under synthetic pointer streams; see `deck.spec.ts:342-352`), and any A11/tablet viewport not run. Also record the known limitation found during design: a **global** `layout_config` change still reaches a connected phone only at its next reconnect, because the host's `state` frame carries per-page `layout_config` but no global field (`server.js:1258-1276`, `App.jsx:783-790`) — now more visible because desktop is the only writer.

- [ ] **Step 8: Stop. Do not merge, push, tag, or publish.**

Report the branch state (`git log --oneline ecf33c6..HEAD`, `git status`) and hand the integration decision back.

---

## Self-review record

**Spec coverage:** sheet volume/mic removal → Task 4; settings-to-desktop → Task 5; sheet compactness/landscape → Task 6; widget drag affordance + cancel + keyboard alternative → Task 9; widget/button interleaved reorder → already shipped in `e8b1925`, verified in Task 12 Step 6 rather than re-implemented; page reordering desktop → Task 10; mobile → Task 8 (+ the draft model in Task 7); persistence/sync → Tasks 1-3; Unfiled handling → Tasks 1, 3, 8, 10 + fixture test 7; docs → Task 11; verification matrix → Task 12.

**Placeholders:** the two spots that say "adapt to the existing names" (`addPage`/`deletePage` in Task 10 Step 6, and the second-page id in Task 8 Step 8) point at exact line ranges to read first, because those functions' local variable names are not quoted here. Everything else is literal code.

**Type consistency:** `applyPageOrder`/`firstVisiblePage` (Task 1) → `applyPageReorder` (Task 2) → `db.applyPageReorder` + `firstVisiblePage` (Task 3). `draft.pageOrder` / `shiftPage` / `diffDraft().pageOrder` / `pagesInOrder` (Task 7) → `handleShiftPage` / `orderedPages` / `onShiftPage` / `pagerPages` (Task 8). `reorder_pages {page_ids}` is one shape everywhere. `pageSortableId` / `PAGE_RAIL_PREFIX` defined once (Task 10 Step 2) and used in Steps 3-4.

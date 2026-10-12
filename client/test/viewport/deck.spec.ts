// Task 7.1 — Playwright viewport-matrix spec. Runs once per VIEWPORTS project
// (see playwright.config.ts, which loops the frozen Phase-1 matrix from
// ../viewports.js) against the REAL production bundle served by `vite
// preview`, with `?mock=1` swapping the phone's socket for the in-memory
// stand-in in src/mock/mockSocket.js. The deck the assertions read is rendered
// by the shipped App.jsx + layout engine: fixture frames only feed host data;
// every geometry check is a real getBoundingClientRect off the built DOM.
//
// Six required assertions per viewport:
//  1. no horizontal overflow
//  2. every fixture tile present + fully inside the grid box
//  3. tile size within the active settings' cell bounds (engine defaults:
//     the fixture carries no layout_config and the mocked GET /api/settings
//     returns null, so the running deck resolves mergeLayout(null, undefined)
//     = DEFAULT_SETTINGS → resolveBounds gives the balanced preset bounds —
//     read from the engine module itself, not magic numbers)
//  4. a widget_data tick updates the tile WITHOUT re-measuring the grid
//  5. status handle: tap opens the sheet, pull-down drag opens it, Escape closes
//  6. edit mode: tap-select → resize → drag-reorder → Save, with the diff
//     reaching the socket (captured `send()` frames) and REST (route capture)
//
// Five more, added with page reordering (final polish, Task 8), and two more
// from the final-review fix round (the page-order claim model):
//  7. the hidden Unfiled page stays out of the pager, and a draft page move
//     commits exactly one reorder_pages frame — after the item reorders
//  8. Done (Discard) restores the original page order and never writes it
//  9. a pending page move survives the two mid-draft draft rebuilds (page fold,
//     host re-seed)
// 10. a host-rejected page order stays saveable and re-commits on a second Save
// 11. a page created mid-draft becomes a live, reorderable row
// 12. a remote reorder is FOLLOWED (an unclaimed draft never re-asserts it)
// 13. a remote page delete inside the Save window still heals the order axis
//
// Standing owner rule verified in EVERY test: no WebSocket to port 9001 or any
// host is ever attempted (page.on("websocket") stays empty), and all REST
// traffic to the host origin is intercepted by page.route before the network.
import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_SETTINGS, resolveBounds, spanFor } from "../../src/layout/deckLayout.js";

const TILE_IDS = [1, 2, 3, 4, 101]; // page_main membership in the fixture

type Captured = {
  api: { method: string; url: string; postData: string | null }[];
  sockets: string[];
};

type Harness = { captured: Captured; fixture: any };

/**
 * Load the production bundle with ?mock=1 and wait until the deck is live:
 * grid measured, all fixture tiles placed, and the widget tile showing the
 * cpu value from the FIRST widget_data tick — proof the frames rode the real
 * message handlers, not an echo of the fixture file.
 */
async function openMockDeck(page: Page): Promise<Harness> {
  const captured: Captured = { api: [], sockets: [] };
  page.on("websocket", (ws) => captured.sockets.push(ws.url()));

  // The un-mocked app would talk to the host at :9001 (ws + REST on the same
  // origin). Intercept the REST origin outright so a leak is impossible and
  // visible; the WS leak cannot even be attempted because App.jsx constructs
  // the stub instead of ReconnectingWebSocket behind the flag.
  const hostApi = (pathname: string) => {
    if (pathname === "/api/widget-sources") {
      return [{ id: "src-local", name: "This PC", host: "localhost", port: 22 }];
    }
    if (pathname === "/api/settings") return { layout_config: null };
    if (pathname === "/api/layout-presets") return [];
    return { ok: true };
  };
  for (const origin of ["http://localhost:9001", "http://127.0.0.1:9001"]) {
    await page.route(`${origin}/**`, async (route) => {
      const req = route.request();
      // The page is served from :4173, so every host call is cross-origin —
      // the synthetic responses must carry CORS or the browser refuses to
      // read them (the preflight gets an explicit answer too).
      const cors = {
        "access-control-allow-origin": "*",
        "access-control-allow-headers": "content-type,x-echodeck-token",
        "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      };
      if (req.method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: cors });
        return;
      }
      captured.api.push({
        method: req.method(),
        url: req.url(),
        postData: req.postData(),
      });
      await route.fulfill({
        status: 200,
        headers: { ...cors, "content-type": "application/json" },
        body: JSON.stringify(hostApi(new URL(req.url()).pathname)),
      });
    });
  }

  await page.goto("/?mock=1");
  await expect(page.locator("[data-deck-grid]")).toBeVisible();
  // The host's `state` frame carries the viewed page's tiles only (page_two
  // ships empty in the fixture), so exactly the five page_main members render.
  await expect(page.locator("[data-deck-item]")).toHaveCount(TILE_IDS.length);
  // The widget tile shows ticks[0].cpu — the state frame + first widget_data
  // frame were consumed through the app's real WS message handlers.
  await expect(page.locator('[data-deck-item="101"]')).toContainText("47%");
  // And the socket stub reports itself connected.
  await expect
    .poll(() => page.evaluate(() => (window as any).__MOCK_WS__?.readyState))
    .toBe(1);

  const fixture = await page.evaluate(() => (window as any).__MOCK_FIXTURE__);
  return { captured, fixture };
}

const assertNoRealSocket = (captured: Captured) =>
  expect(captured.sockets, "no real WebSocket was ever attempted").toEqual([]);

/**
 * Enter edit mode through the sheet's single-tap "Edit Layout" door. Task 6
 * compacted the sheet to two short rows, so at every landscape viewport the
 * button is always inside the min(55%, 220px) cap — no clipping and no
 * long-press fallback. The two guards here are the regression net: the sheet
 * must not overflow its cap (scrollHeight <= clientHeight once the open
 * transition settles), and the Edit Layout click is only actionable when the
 * button is not covered by the sheet's clipped box.
 */
async function enterEditMode(page: Page) {
  await page.locator("[data-status-handle] button").click();
  const sheet = page.locator("#deck-control-sheet");
  await expect
    .poll(
      () => sheet.evaluate((el: HTMLElement) => (el as any).inert === true),
      "the sheet opened (not inert)",
    )
    .toBe(false);
  // Real "does not clip" assertion: the trimmed sheet fits its max-height cap,
  // so nothing is hidden behind the overflow. Would fail if a row ever pushes
  // the content past the cap again.
  await expect
    .poll(
      () => sheet.evaluate((el: HTMLElement) => el.scrollHeight - el.clientHeight),
      "the compacted sheet fits its cap (no internal clipping)",
    )
    .toBeLessThanOrEqual(1);
  await page.getByRole("button", { name: "Edit Layout", exact: true }).click();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
}

async function mockSentFrames(page: Page) {
  return page.evaluate(() =>
    (window as any).__MOCK_WS__.sent.map((s: string) => JSON.parse(s)),
  );
}

/**
 * FEATURE: Page reordering — the Pages disclosure's row labels in list order
 * ("1. Main", …). The panel is the sibling div right after the group holding
 * [Pages ▸], and its only <span>s are those labels (Earlier / Later are buttons),
 * so this reads exactly the sequence the user sees while reordering — the draft's
 * order, not the host's.
 */
async function pagesListLabels(page: Page): Promise<string[]> {
  const panel = page
    .getByRole("button", { name: "Pages ▸", exact: true })
    .locator("xpath=ancestor::div[1]/following-sibling::div[1]");
  const texts = await panel.locator("span").allInnerTexts();
  return texts.map((t) => t.replace(/\s+/g, " ").trim());
}

/**
 * The pager dots in DOM order, by page name. A dot's only accessible name is the
 * page name (`aria-label={p.name}`), so this is both "how many pages navigate"
 * (D3: never the hidden Unfiled one) and "in which order" (the draft's, while
 * editing).
 */
async function dotOrder(page: Page): Promise<string[]> {
  return page
    .locator('button[aria-label="Main"], button[aria-label="Second"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label")));
}

/**
 * Open the Pages disclosure. It is bar-local UI state (like `moveOpen`) and the
 * bar stays mounted with `editMode` as a prop, so a re-entered session can already
 * be showing the list — the toggle only fires when it is not.
 */
async function openPagesDisclosure(page: Page) {
  const trigger = page.getByRole("button", { name: "Pages ▸", exact: true });
  await expect(trigger, "toolbar offers page order").toBeVisible();
  const rows = page.getByRole("button", { name: "Earlier", exact: true });
  if ((await rows.count()) === 0) await trigger.click();
  await expect(rows.first(), "the Pages list is open").toBeVisible();
}

test.describe("deck viewport matrix", () => {
  test("1. no horizontal overflow", async ({ page }) => {
    const { captured } = await openMockDeck(page);
    const box = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(box.scrollWidth).toBe(box.clientWidth);
    assertNoRealSocket(captured);
  });

  test("2. every tile present and fully inside the grid box", async ({ page }) => {
    const { captured } = await openMockDeck(page);
    const problems = await page.evaluate(async (ids: number[]) => {
      const grid = document.querySelector("[data-deck-grid]");
      if (!grid) return ["grid container missing"];
      const out: string[] = [];
      for (const id of ids) {
        const el = document.querySelector(
          `[data-deck-item="${id}"]`,
        ) as HTMLElement | null;
        if (!el) {
          out.push(`missing tile ${id}`);
          continue;
        }
        // The engine may legitimately degrade to vertical scroll (D6) on
        // short viewports; bring the tile into the scroll container's box
        // first, THEN compare rects — containment is asserted against the
        // real rendered geometry in either mode.
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        const g = grid.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const tol = 1.5; // sub-pixel grid rounding
        if (
          r.left < g.left - tol ||
          r.right > g.right + tol ||
          r.top < g.top - tol ||
          r.bottom > g.bottom + tol
        ) {
          const fmt = (b: DOMRect) =>
            [b.left, b.top, b.right, b.bottom].map((v) => v.toFixed(1)).join(",");
          out.push(`tile ${id} [${fmt(r)}] outside grid [${fmt(g)}]`);
        }
      }
      return out;
    }, TILE_IDS);
    expect(problems).toEqual([]);
    assertNoRealSocket(captured);
  });

  test("3. tiles sit on the engine's cell grid within settings bounds", async ({
    page,
  }) => {
    const { captured, fixture } = await openMockDeck(page);
    // Active settings for this run: no layout_config anywhere the mocked host
    // offers, so App resolves mergeLayout(null, undefined) = DEFAULT_SETTINGS.
    // Bounds come from the engine module, not literals.
    const bounds = resolveBounds(DEFAULT_SETTINGS);
    const tiles = [
      ...(fixture.state.buttons || []),
      ...(fixture.state.widgets || []),
    ].map((t: any) => {
      const want = spanFor(t.size);
      return { id: t.id, cols: want.cols, rows: want.rows };
    });
    const problems = await page.evaluate(
      ({ bounds, tiles }: { bounds: any; tiles: any[] }) => {
        const grid = document.querySelector(
          "[data-deck-grid]",
        ) as HTMLElement | null;
        if (!grid) return ["grid container missing"];
        const cs = getComputedStyle(grid);
        const tracks = cs.gridTemplateColumns.split(" ").map(parseFloat);
        const colGap = parseFloat(cs.columnGap) || 0;
        const rowGap = parseFloat(cs.rowGap) || 0;
        const out: string[] = [];
        if (!tracks.length || tracks.some((t) => Number.isNaN(t)))
          return ["grid not placed (no computed tracks)"];
        const cols = tracks.length;
        const cell = tracks[0];
        if (cell < bounds.minCell || cell > bounds.maxCell)
          out.push(
            `cell ${cell}px outside [${bounds.minCell}, ${bounds.maxCell}]`,
          );
        if (Math.abs(colGap - bounds.gap) > 0.01 || Math.abs(rowGap - bounds.gap) > 0.01)
          out.push(`gap ${colGap}/${rowGap} != settings gap ${bounds.gap}`);
        tracks.forEach((t, i) => {
          if (Math.abs(t - cell) > 0.51)
            out.push(`track ${i} is ${t}px, expected ${cell}px`);
        });
        const spanPx = (span: number, gap: number) => span * cell + (span - 1) * gap;
        for (const t of tiles) {
          const el = document.querySelector(
            `[data-deck-item="${t.id}"]`,
          ) as HTMLElement | null;
          if (!el) {
            out.push(`missing tile ${t.id}`);
            continue;
          }
          el.scrollIntoView({ block: "nearest", inline: "nearest" });
          const r = el.getBoundingClientRect();
          // Engine contract: a wide span on a narrow grid is clamped, never
          // dropped (D6) — expect the clamped footprint from the real cols.
          const wantCols = Math.min(t.cols, cols);
          const dW = Math.abs(r.width - spanPx(wantCols, colGap));
          const dH = Math.abs(r.height - spanPx(t.rows, rowGap));
          if (dW > 1.5 || dH > 1.5) {
            out.push(
              `tile ${t.id} is ${r.width.toFixed(1)}x${r.height.toFixed(1)}, expected ` +
                `${spanPx(wantCols, colGap)}x${spanPx(t.rows, rowGap)} (Δ ${dW.toFixed(1)}/${dH.toFixed(1)})`,
            );
          }
        }
        return out;
      },
      { bounds, tiles },
    );
    expect(problems).toEqual([]);
    assertNoRealSocket(captured);
  });

  test("4. widget_data tick updates the tile without re-measuring the grid", async ({
    page,
  }) => {
    const { captured, fixture } = await openMockDeck(page);
    const read = () =>
      page.evaluate(() => ({ ...(window as any).__DECK_MEASURES__ }));
    const before = await read();
    // Let any start-up ResizeObserver/rAF settling pass before the baseline.
    await page.waitForTimeout(250);
    const settled = await read();
    expect(settled, "measurement counters settled after load").toEqual(before);

    await page.evaluate((tick) => (window as any).__MOCK_WS__.pushFrame(tick), fixture.ticks[1]);
    await expect(page.locator('[data-deck-item="101"]')).toContainText("77%");

    const after = await read();
    expect(after.ro, "grid ResizeObserver fired again").toBe(settled.ro);
    expect(after.recompute, "computeDeckLayout ran again").toBe(
      settled.recompute,
    );
    assertNoRealSocket(captured);
  });

  test("5. status handle: tap opens the sheet, Escape closes, pull-down opens", async ({
    page,
  }) => {
    const { captured } = await openMockDeck(page);
    const sheet = page.locator("#deck-control-sheet");
    const handleButton = page.locator("[data-status-handle] button");
    const isInert = () =>
      sheet.evaluate((el: HTMLElement) => (el as any).inert === true);

    await expect.poll(isInert, "sheet starts collapsed").toBe(true);

    // Tap the handle → sheet opens.
    await handleButton.click();
    await expect.poll(isInert, "tap opened the sheet").toBe(false);
    await expect(handleButton).toHaveAttribute("aria-expanded", "true");

    // Escape closes.
    await page.keyboard.press("Escape");
    await expect.poll(isInert, "Escape closed the sheet").toBe(true);

    // A downward pull starting on the top strip opens it (Task 5.3 gesture:
    // origin inside the 28-px strip, travel dy >= 24 and vertical-dominant).
    const vp = page.viewportSize()!;
    await page.mouse.move(vp.width / 2, 8);
    await page.mouse.down();
    for (let y = 20; y <= 64; y += 11) await page.mouse.move(vp.width / 2, y);
    await page.mouse.up();
    await expect
      .poll(isInert, "pull-down opened the sheet")
      .toBe(false);

    // Tapping the handle again toggles the open sheet shut.
    await handleButton.click();
    await expect.poll(isInert, "handle closes the open sheet").toBe(true);
    assertNoRealSocket(captured);
  });

  test("6. edit mode: tap-select, resize, move to page, Save emits the diff", async ({
    page,
  }) => {
    const { captured } = await openMockDeck(page);
    await enterEditMode(page);

    const saveBtn = page.getByRole("button", { name: "Save", exact: true });
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn, "clean draft starts not-dirty").toBeDisabled();

    // Tap-select tile 1 and resize it 1x1 -> 1x2 through the toolbar.
    const t1 = page.locator('[data-deck-item="1"]');
    await t1.scrollIntoViewIfNeeded();
    await t1.click();
    const seg = page.getByRole("button", { name: "1×2", exact: true });
    await expect(seg, "toolbar shows the size segments for the selected tile").toBeVisible();
    await seg.click();
    await expect(saveBtn, "resize marks the draft dirty").toBeEnabled();

    // Re-parent tile 1 onto page_two through the toolbar's Move-to-page —
    // the deterministic path to a reorder_items diff. (A dnd-kit drag-reorder
    // was tried first and is NOT driven here: with the shipped live drop
    // preview, a synthetic pointer that lands on the target recomputes
    // collisions after the preview relayout and the source tile's own node
    // ends up under the ghost, so event.over comes back as the active tile
    // and the drop is discarded by design ("was dropped over droppable area
    // button:2" in dnd-kit's own live region). Drag reordering stays covered
    // by the layoutDraft unit tests and the T7.3 physical checklist; what
    // this matrix must prove — that a committed layout diff reaches the
    // socket as a reorder_items frame — the move exercises exactly.)
    const moveBtn = page.getByRole("button", { name: "Move to page ▸", exact: true });
    await expect(moveBtn, "toolbar offers the move menu").toBeVisible();
    await moveBtn.click();
    const editorBar = moveBtn.locator("xpath=ancestor::div[2]");
    await editorBar.getByRole("button", { name: "Second", exact: true }).click();
    await expect(saveBtn, "move keeps the draft dirty").toBeEnabled();

    await saveBtn.click();

    // handleSave is an async chain: POST moves -> PATCH sizes -> reorder_items
    // WS frames -> toast (App.jsx). Reading the captures right after the click
    // races those awaits (an early run saw the POST land but zero frames).
    // The "Sent — waiting for host" toast fires synchronously after the LAST
    // socket.send, so it is the deterministic point to read the captures.
    // If the save instead failed, this assertion shows the app's own
    // "Save failed: ..." toast text as the received value. (dnd-kit renders
    // its own role="status" live region, so exclude it by id prefix.)
    const toast = page.locator('[role="status"]:not([id^="DndLiveRegion"])');
    await expect(toast).toContainText("Sent", { timeout: 10_000 });

    // The reorder half of the diff rides the WS: one reorder_items frame per
    // affected page, dense slots 0..n-1 over that page's full membership,
    // kinds preserved. page_main loses tile 1 and re-densifies; page_two
    // gains it at slot 0.
    const sent = await mockSentFrames(page);
    const reorders = sent.filter((f: any) => f.t === "reorder_items");
    const byPage: Record<string, any[]> = Object.fromEntries(
      reorders.map((f: any) => [f.page_id, f.items]),
    );
    expect(
      reorders.length,
      `frames=${JSON.stringify(sent)} api=${JSON.stringify(captured.api)}`,
    ).toBe(2);
    for (const f of reorders) expect(f.v).toBe(1);
    expect(byPage["page_main"].map((i: any) => i.id)).toEqual([2, 3, 4, 101]);
    expect(byPage["page_main"].map((i: any) => i.slot)).toEqual([0, 1, 2, 3]);
    expect(byPage["page_main"].map((i: any) => i.kind)).toEqual([
      "button",
      "button",
      "button",
      "widget",
    ]);
    expect(byPage["page_two"].map((i: any) => i.id)).toEqual([1]);
    expect(byPage["page_two"].map((i: any) => [i.kind, i.slot])).toEqual([
      ["button", 0],
    ]);

    // The size half rides the REST routes (handleSave contract: moves +
    // size PATCHes first, then the WS reorders) — captured by the
    // interceptor, never sent to a real host.
    const move = captured.api.find(
      (c) => c.method === "POST" && /\/api\/items\/move$/.test(c.url),
    );
    expect(move, "move emitted POST /api/items/move").toBeTruthy();
    expect(JSON.parse(move!.postData!)).toEqual({
      kind: "button",
      id: "1",
      page_id: "page_two",
      slot: 0,
    });
    const patch = captured.api.find(
      (c) => c.method === "PATCH" && /\/api\/buttons\/1$/.test(c.url),
    );
    expect(patch, "resize emitted PATCH /api/buttons/1").toBeTruthy();
    expect(JSON.parse(patch!.postData!)).toEqual({ size: "1x2" });

    assertNoRealSocket(captured);
  });

  test("7. pages: the Unfiled page stays out of navigation, and a move emits reorder_pages", async ({
    page,
  }) => {
    const { captured } = await openMockDeck(page);

    // D3 still holds after reordering landed: a hidden page never reaches the
    // dots. Counted rather than eyeballed, because the fixture now has three
    // pages and only two are visible.
    const dotCount = await page
      .locator(
        '[aria-label="Main"], [aria-label="Second"], [aria-label="Unfiled"]',
      )
      .count();
    expect(dotCount, "Unfiled stays absent from the pager").toBe(2);

    await enterEditMode(page);
    // FEATURE: Page reordering — a DECK-level control: the disclosure is offered
    // before any tile is selected, because page order is not a per-item edit.
    await openPagesDisclosure(page);

    // Active-page cue (the reviewer's Minor): exactly one Pages LIST row carries
    // aria-current="true", and it is the CURRENT page's numbered row — the sole
    // owner ruling on this surface that had no regression guard. Scoped to the
    // disclosure panel because the pager dots reuse the same aria-current cue.
    const pagesPanel = page
      .getByRole("button", { name: "Pages ▸", exact: true })
      .locator("xpath=ancestor::div[1]/following-sibling::div[1]");
    const current = pagesPanel.locator('[aria-current="true"]');
    await expect(current, "exactly one Pages row is the active page").toHaveCount(1);
    expect(
      (await current.innerText()).replace(/\s+/g, " ").trim(),
      "the cue sits on the current page's numbered row",
    ).toMatch(/^1\. Main/);

    // The ends of the list are dead ends, and that is what makes this surface
    // verifiable: the first page cannot go earlier, the last cannot go later.
    const earlier = page.getByRole("button", { name: "Earlier", exact: true });
    await expect(earlier.first()).toBeDisabled();
    const later = page.getByRole("button", { name: "Later", exact: true });
    await expect(later.last()).toBeDisabled();
    expect(await pagesListLabels(page), "opens in the host's order").toEqual([
      "1. Main",
      "2. Second",
    ]);

    await later.first().click(); // Main steps behind Second
    await expect
      .poll(() => pagesListLabels(page), "the list repaints in draft order")
      .toEqual(["1. Second", "2. Main"]);
    await expect
      .poll(() => dotOrder(page), "the pager dots follow the draft")
      .toEqual(["Second", "Main"]);

    const saveBtn = page.getByRole("button", { name: "Save", exact: true });
    await expect(
      saveBtn,
      "a page move alone makes the draft saveable",
    ).toBeEnabled();

    // One item change in the same session, so Save emits BOTH frame families and
    // the ordering rule becomes observable: the page batch must not overtake the
    // item reorders it depends on.
    const t1 = page.locator('[data-deck-item="1"]');
    await t1.scrollIntoViewIfNeeded();
    await t1.click();
    const moveBtn = page.getByRole("button", {
      name: "Move to page ▸",
      exact: true,
    });
    await expect(moveBtn, "toolbar offers the move menu").toBeVisible();
    await moveBtn.click();
    // Scoped like test 6: inside the bar only — a dot is also a button whose
    // accessible name is "Second".
    const editorBar = moveBtn.locator("xpath=ancestor::div[2]");
    await editorBar.getByRole("button", { name: "Second", exact: true }).click();

    const before = await mockSentFrames(page);
    expect(
      before.filter((f: any) => f.t === "reorder_pages").length,
      "no page-order write while the draft is open",
    ).toBe(0);

    await saveBtn.click();
    const toast = page.locator('[role="status"]:not([id^="DndLiveRegion"])');
    await expect(toast).toContainText("Sent", { timeout: 10_000 });

    const sent = await mockSentFrames(page);
    const frames = sent.filter((f: any) => f.t === "reorder_pages");
    expect(frames.length, "one page-order frame per Save").toBe(1);
    expect(frames[0].v).toBe(1);
    expect(frames[0].page_ids).toEqual(["page_two", "page_main"]);
    expect(
      frames[0].page_ids.includes("page_hidden"),
      "a hidden page is never part of the batch",
    ).toBe(false);

    const kinds = sent.map((f: any) => f.t);
    const lastItem = kinds.lastIndexOf("reorder_items");
    expect(lastItem, "the Save also emitted the item reorder").toBeGreaterThan(
      -1,
    );
    expect(
      kinds.indexOf("reorder_pages"),
      "reorder_pages rides after every reorder_items frame",
    ).toBeGreaterThan(lastItem);

    assertNoRealSocket(captured);
  });

  // Step 10 of the plan asked for a throwaway Discard check. It is permanent
  // instead: "Discard restores the original page order" is an owner ruling, so it
  // deserves a regression guard, not a one-off observation.
  test("8. pages: Done (Discard) restores the original page order and never writes it", async ({
    page,
  }) => {
    const { captured } = await openMockDeck(page);
    await enterEditMode(page);
    await openPagesDisclosure(page);
    expect(await pagesListLabels(page)).toEqual(["1. Main", "2. Second"]);

    await page.getByRole("button", { name: "Later", exact: true }).first().click();
    await expect
      .poll(() => pagesListLabels(page), "the move is pending in the draft")
      .toEqual(["1. Second", "2. Main"]);
    await expect
      .poll(() => dotOrder(page), "pending, and visible on the dots")
      .toEqual(["Second", "Main"]);

    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Pages ▸", exact: true }),
      "Done leaves edit mode",
    ).toBeHidden();

    // Asserted on the wire, not on the pixels: a frame already sent cannot be
    // undone by leaving edit mode, so "Discard never persisted it" is the real
    // half of the owner's ruling.
    const sent = await mockSentFrames(page);
    expect(
      sent.filter((f: any) => f.t === "reorder_pages").length,
      "Discard never emitted a page-order frame",
    ).toBe(0);

    // Re-enter: the draft re-seeds from the host's authoritative order, so the
    // original order is back on the list AND the dots, and Save is clean again.
    await enterEditMode(page);
    await openPagesDisclosure(page);
    await expect
      .poll(() => pagesListLabels(page), "Discard restored the page order")
      .toEqual(["1. Main", "2. Second"]);
    await expect
      .poll(() => dotOrder(page), "the dots show the restored order")
      .toEqual(["Main", "Second"]);
    await expect(
      page.getByRole("button", { name: "Save", exact: true }),
      "a discarded page move leaves nothing pending",
    ).toBeDisabled();

    const after = await mockSentFrames(page);
    expect(
      after.filter((f: any) => f.t === "reorder_pages").length,
      "still zero page-order frames for the whole session",
    ).toBe(0);
    assertNoRealSocket(captured);
  });

  // Regression guard for the two draft-rebuild sites the page order has to survive:
  // foldPageIntoDraft (a page the draft does not own yet) and
  // reseedPageFromServer (a host snapshot whose membership diverged). Both call
  // createDraft, whose pageOrder defaults to [] — so if either forgot to pass
  // draft.pageOrder through, a pending page move resets silently and Save emits no
  // reorder_pages frame at all.
  test("9. pages: a pending page move survives a mid-draft fold and a host re-seed", async ({
    page,
  }) => {
    const { captured, fixture } = await openMockDeck(page);
    await enterEditMode(page);
    await openPagesDisclosure(page);
    await page.getByRole("button", { name: "Later", exact: true }).first().click();
    await expect
      .poll(() => pagesListLabels(page), "the page move is pending")
      .toEqual(["1. Second", "2. Main"]);

    // (A) FOLD. The draft owns only the viewed page's rows, so the first edit on
    // another page rebuilds it through foldPageIntoDraft -> createDraft. A real
    // host answers a page switch with that page's `state` frame; the mock socket
    // does not, so push one for page_two carrying a tile of its own.
    await page.evaluate((pages) => {
      (window as any).__MOCK_WS__.pushFrame({
        t: "state",
        pages,
        current_page: "page_two",
        buttons: [
          {
            id: 77,
            page_id: "page_two",
            name: "Seventy",
            slot: 0,
            size: "1x1",
            action_type: "key",
            action_value: "Seven",
            icon: "keyboard",
          },
        ],
        widgets: [],
      });
    }, fixture.state.pages);
    const t77 = page.locator('[data-deck-item="77"]');
    await expect(t77, "the framed page renders its own tile").toBeVisible();
    await t77.click();
    await page.getByRole("button", { name: "1×2", exact: true }).click();
    await expect
      .poll(
        () => pagesListLabels(page),
        "folding page_two into the draft kept the pending page move",
      )
      .toEqual(["1. Second", "2. Main"]);

    // (B) RE-SEED. Move a page_main tile off its page, deliver the host snapshot
    // for page_main, and the draft's membership for that page now disagrees with
    // the server's — the exact condition reseedPageFromServer rebuilds under.
    await page.locator('button[aria-label="Main"]').click(); // switchPage
    const t1 = page.locator('[data-deck-item="1"]');
    await t1.scrollIntoViewIfNeeded();
    await t1.click();
    const moveBtn = page.getByRole("button", {
      name: "Move to page ▸",
      exact: true,
    });
    await moveBtn.click();
    await moveBtn
      .locator("xpath=ancestor::div[2]")
      .getByRole("button", { name: "Second", exact: true })
      .click();
    await expect(
      t1,
      "the moved tile leaves page_main in the draft",
    ).toBeHidden();

    await page.evaluate((state) => (window as any).__MOCK_WS__.pushFrame(state), fixture.state);
    await expect(
      t1,
      "the host snapshot re-seeded page_main into the draft",
    ).toBeVisible();
    await expect
      .poll(
        () => pagesListLabels(page),
        "the re-seed kept the pending page move",
      )
      .toEqual(["1. Second", "2. Main"]);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    const toast = page.locator('[role="status"]:not([id^="DndLiveRegion"])');
    await expect(toast).toContainText("Sent", { timeout: 10_000 });

    const sent = await mockSentFrames(page);
    const frames = sent.filter((f: any) => f.t === "reorder_pages");
    expect(
      frames.length,
      `both rebuilds preserved draft.pageOrder; sent=${JSON.stringify(sent)}`,
    ).toBe(1);
    expect(frames[0].page_ids).toEqual(["page_two", "page_main"]);
    // The re-seeded page_main re-converged with the server, so it no longer needs
    // an item batch; the moved tile shows up on page_two's page only.
    expect(sent.filter((f: any) => f.t === "reorder_items").map((f: any) => f.page_id)).toEqual([
      "page_two",
    ]);
    expect(
      sent.map((f: any) => f.t).indexOf("reorder_pages"),
      "page order still commits after the item batches",
    ).toBeGreaterThan(
      sent.map((f: any) => f.t).lastIndexOf("reorder_items"),
    );

    assertNoRealSocket(captured);
  });

  // Save is optimistic: it advances the baseline and the host answers a rejected
  // reorder_pages with silence, so a baseline-only comparison would strand the
  // unaccepted order with Save disabled and no escape but leaving Edit Layout. The
  // batch is measured against the HOST, so a rejected claim keeps Save enabled and
  // a re-tap re-commits it — and once the host's echo carries the order the batch
  // empties and Save goes dark. The mock is a pure sink (it never applies writes),
  // which is exactly what makes the rejection path testable.
  test("10. pages: a rejected order stays saveable and re-commits on a second Save", async ({
    page,
  }) => {
    const { captured, fixture } = await openMockDeck(page);
    await enterEditMode(page);
    await openPagesDisclosure(page);

    await page.getByRole("button", { name: "Later", exact: true }).first().click();
    await expect
      .poll(() => pagesListLabels(page), "Main steps behind Second")
      .toEqual(["1. Second", "2. Main"]);

    const saveBtn = page.getByRole("button", { name: "Save", exact: true });
    const toast = page.locator('[role="status"]:not([id^="DndLiveRegion"])');
    await expect(saveBtn, "a page move alone makes the draft dirty").toBeEnabled();
    await saveBtn.click();
    await expect(toast).toContainText("Sent", { timeout: 10_000 });

    let frames = (await mockSentFrames(page)).filter(
      (f: any) => f.t === "reorder_pages",
    );
    expect(frames.length, "exactly one page-order frame on the first Save").toBe(1);
    expect(frames[0].page_ids).toEqual(["page_two", "page_main"]);

    // The mock never accepted the order, so the draft still disagrees with the
    // host's sequence — Save must STAY enabled. This is the retry the finding asked
    // for; before the host-measured batch it went dark because the baseline matched.
    await expect(
      saveBtn,
      "an order the host never accepted keeps Save enabled",
    ).toBeEnabled();
    await saveBtn.click();
    await expect(toast).toContainText("Sent", { timeout: 10_000 });

    frames = (await mockSentFrames(page)).filter(
      (f: any) => f.t === "reorder_pages",
    );
    expect(frames.length, "the retry re-commits a second frame").toBe(2);
    expect(frames[0].page_ids).toEqual(["page_two", "page_main"]);
    expect(frames[1].page_ids, "identical batch both times").toEqual([
      "page_two",
      "page_main",
    ]);

    // Now the host agrees: push a state frame whose pages array is already in the
    // batch's order ([page_two, page_main, page_hidden]), reusing the rest of the
    // snapshot. The heal keeps the draft's set; the host comparison empties the
    // batch, so Save goes dark — nothing left to send.
    const agreed = {
      ...fixture.state,
      pages: [
        fixture.state.pages[1],
        fixture.state.pages[0],
        fixture.state.pages[2],
      ],
    };
    await page.evaluate((frame) => (window as any).__MOCK_WS__.pushFrame(frame), agreed);
    await expect(
      saveBtn,
      "the host agreed; there is nothing left to commit",
    ).toBeDisabled();

    assertNoRealSocket(captured);
  });

  // A page the host creates AFTER the draft was seeded was the dead-row condition:
  // pagesInOrder trails it as a live row, but the draft never owned it, so
  // shiftPage returned the same draft and the row's Earlier/Later silently did
  // nothing. reconcilePageOrder heals the draft's page-order SET from every state
  // frame, so the new page is owned and its row is genuinely interactive.
  test("11. pages: a page created mid-draft becomes a live, reorderable row", async ({
    page,
  }) => {
    const { captured, fixture } = await openMockDeck(page);
    await enterEditMode(page);

    // The host creates one extra VISIBLE page (hidden absent). The mock never
    // applies writes, so this frame is the only way the draft learns of it.
    const withThree = {
      ...fixture.state,
      pages: [
        ...fixture.state.pages,
        { id: "page_three", name: "Third", position: 3 },
      ],
    };
    await page.evaluate((frame) => (window as any).__MOCK_WS__.pushFrame(frame), withThree);

    await openPagesDisclosure(page);
    await expect
      .poll(() => pagesListLabels(page), "the healed order is a full permutation")
      .toEqual(["1. Main", "2. Second", "3. Third"]);
    await expect
      .poll(
        () =>
          page
            .locator('[aria-label="Main"], [aria-label="Second"], [aria-label="Third"]')
            .count(),
        "the new page is reachable through the dots",
      )
      .toBe(3);

    // The new row is the tail, so — because the healed order is a real permutation
    // — its Earlier is live and its Later is correctly disabled (a genuine last
    // row). The reviewer's draft said "both enabled"; that cannot hold for a tail
    // row, and asserting the disabled Later is exactly the point: index-based
    // disabling is now correct. Liveness is proven by the click, not the state.
    const earlier = page.getByRole("button", { name: "Earlier", exact: true });
    const later = page.getByRole("button", { name: "Later", exact: true });
    await expect(earlier.last(), "the healed new row offers a working Earlier").toBeEnabled();
    await expect(later.last(), "the tail row's Later is honestly disabled").toBeDisabled();

    const saveBtn = page.getByRole("button", { name: "Save", exact: true });
    await earlier.last().click();
    await expect(
      saveBtn,
      "the new row is owned: its Earlier actually dirties the draft",
    ).toBeEnabled();

    await saveBtn.click();
    const toast = page.locator('[role="status"]:not([id^="DndLiveRegion"])');
    await expect(toast).toContainText("Sent", { timeout: 10_000 });

    const frames = (await mockSentFrames(page)).filter(
      (f: any) => f.t === "reorder_pages",
    );
    expect(frames.length, "one page-order frame for the new page").toBe(1);
    expect(
      frames[0].page_ids.includes("page_three"),
      `the batch carries the created page; got ${JSON.stringify(frames[0].page_ids)}`,
    ).toBe(true);

    assertNoRealSocket(captured);
  });

  // Final-review fix 1 (Important 1): the host-measured batch used to fire for
  // ANY draft/host order divergence — including one this phone never authored.
  // A remote client's reorder then let an unrelated phone Save silently
  // re-assert the stale order. Under the claim model an unclaimed draft FOLLOWS
  // the host: Save stays dark on someone else's reorder, the dots stay honest,
  // and a resize Save emits no reorder_pages frame at all.
  test("12. pages: a remote reorder is followed, never re-asserted by an unrelated Save", async ({
    page,
  }) => {
    const { captured, fixture } = await openMockDeck(page);
    await enterEditMode(page);
    await openPagesDisclosure(page);
    expect(await pagesListLabels(page), "opens in the host's order").toEqual([
      "1. Main",
      "2. Second",
    ]);

    // Another client reorders the deck: the SAME visible set, a different order.
    const remote = {
      ...fixture.state,
      pages: [
        fixture.state.pages[1],
        fixture.state.pages[0],
        fixture.state.pages[2],
      ],
    };
    await page.evaluate(
      (frame) => (window as any).__MOCK_WS__.pushFrame(frame),
      remote,
    );

    const saveBtn = page.getByRole("button", { name: "Save", exact: true });
    await expect(
      saveBtn,
      "a reorder this client did not author cannot light up Save",
    ).toBeDisabled();
    await expect
      .poll(() => pagesListLabels(page), "the unclaimed draft follows the host")
      .toEqual(["1. Second", "2. Main"]);
    await expect
      .poll(() => dotOrder(page), "the dots stay honest about the host's order")
      .toEqual(["Second", "Main"]);

    // The one Save-worthy change in this draft is a tile resize.
    const t1 = page.locator('[data-deck-item="1"]');
    await t1.scrollIntoViewIfNeeded();
    await t1.click();
    await page.getByRole("button", { name: "1×2", exact: true }).click();
    await expect(saveBtn, "the resize alone dirties the draft").toBeEnabled();
    await saveBtn.click();
    const toast = page.locator('[role="status"]:not([id^="DndLiveRegion"])');
    await expect(toast).toContainText("Sent", { timeout: 10_000 });

    const sent = await mockSentFrames(page);
    expect(
      sent.filter((f: any) => f.t === "reorder_pages").length,
      `the phone never re-asserts an order it did not author; sent=${JSON.stringify(sent)}`,
    ).toBe(0);

    assertNoRealSocket(captured);
  });

  // Final-review fix 1 (Important 2): the order heal used to hide behind the
  // saveInFlight gate. A remote page DELETE landing inside the Save window was
  // skipped entirely — after Save the baseline held a phantom id, the
  // host-measured batch returns [] on a length mismatch, and Save went dark for
  // good with no later frame guaranteed to reopen it. The order axis now heals
  // on EVERY state frame; the item re-seed stays gated (it exists for our own
  // echoes arriving out of order).
  test("13. pages: a remote delete inside the Save window still heals and stays committable", async ({
    page,
  }) => {
    const { captured, fixture } = await openMockDeck(page);
    await enterEditMode(page);

    const THIRD = { id: "page_three", name: "Third", position: 3 };
    const withThree = {
      ...fixture.state,
      pages: [...fixture.state.pages, THIRD],
    };
    await page.evaluate(
      (frame) => (window as any).__MOCK_WS__.pushFrame(frame),
      withThree,
    );

    await openPagesDisclosure(page);
    await expect
      .poll(
        () => pagesListLabels(page),
        "the new page is adopted while no claim stands",
      )
      .toEqual(["1. Main", "2. Second", "3. Third"]);

    // A real claim: Second past Main, then Third past Second, so the draft
    // order is [page_two, page_three, page_main].
    await page.getByRole("button", { name: "Later", exact: true }).first().click();
    await expect
      .poll(() => pagesListLabels(page))
      .toEqual(["1. Second", "2. Main", "3. Third"]);
    await page.getByRole("button", { name: "Earlier", exact: true }).last().click();
    await expect
      .poll(() => pagesListLabels(page))
      .toEqual(["1. Second", "2. Third", "3. Main"]);

    // A tile resize joins the Save, deliberately: the REST write it awaits is
    // what gives the Save a REAL in-flight window. A page-order-only Save runs
    // synchronously (no await between gate-on and gate-off), so no externally
    // pushed frame could ever land inside it.
    const t1 = page.locator('[data-deck-item="1"]');
    await t1.scrollIntoViewIfNeeded();
    await t1.click();
    await page.getByRole("button", { name: "1×2", exact: true }).click();

    // The host deletes page_two. The frame is pushed from INSIDE the resize
    // PATCH's route handler before the route fulfils — the Save's fetch cannot
    // resolve before the fulfil, so the frame provably arrives while
    // saveInFlight is still true.
    const deleted = {
      ...fixture.state,
      pages: [fixture.state.pages[0], THIRD, fixture.state.pages[2]],
    };
    let deleteLanded = false;
    for (const origin of ["http://localhost:9001", "http://127.0.0.1:9001"]) {
      await page.route(`${origin}/api/buttons/1`, async (route) => {
        const req = route.request();
        const cors = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "content-type,x-echodeck-token",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        };
        if (req.method() === "OPTIONS") {
          await route.fulfill({ status: 204, headers: cors });
          return;
        }
        if (!deleteLanded) {
          deleteLanded = true;
          await page.evaluate(
            (frame) => (window as any).__MOCK_WS__.pushFrame(frame),
            deleted,
          );
          // Hold the Save open long enough for the healed render to settle.
          await new Promise((r) => setTimeout(r, 250));
        }
        await route.fulfill({
          status: 200,
          headers: { ...cors, "content-type": "application/json" },
          body: JSON.stringify({ ok: true }),
        });
      });
    }

    const saveBtn = page.getByRole("button", { name: "Save", exact: true });
    await expect(saveBtn, "claim + resize make the draft dirty").toBeEnabled();
    await saveBtn.click();
    const toast = page.locator('[role="status"]:not([id^="DndLiveRegion"])');
    await expect(toast, "the held write completes the Save").toContainText("Sent", {
      timeout: 10_000,
    });

    // (i) The mid-Save delete healed: the dead page's row and dot are gone and
    // the survivors read in the healed draft order.
    await expect
      .poll(
        () => pagesListLabels(page),
        "the deleted page's toolbar row is gone",
      )
      .toEqual(["1. Third", "2. Main"]);
    await expect
      .poll(() => dotOrder(page), "the deleted page's dot is gone")
      .toEqual(["Main"]);

    // (ii) Save STAYS enabled — the healed claim is real and still unaccepted.
    await expect(
      saveBtn,
      "the healed, still-uncommitted order keeps Save enabled",
    ).toBeEnabled();

    // (iii) The retry commits a batch with no deleted id and the host's
    // current visible length.
    await saveBtn.click();
    await expect(toast).toContainText("Sent", { timeout: 10_000 });
    const frames = (await mockSentFrames(page)).filter(
      (f: any) => f.t === "reorder_pages",
    );
    expect(frames.length, "one batch on the first Save, one on the retry").toBe(2);
    expect(
      frames[1].page_ids.includes("page_two"),
      `the retry carries no deleted id; got ${JSON.stringify(frames[1].page_ids)}`,
    ).toBe(false);
    expect(frames[1].page_ids).toEqual(["page_three", "page_main"]);
    expect(
      frames[1].page_ids.length,
      "the batch has the host's current visible-page count",
    ).toBe(2);

    assertNoRealSocket(captured);
  });
});

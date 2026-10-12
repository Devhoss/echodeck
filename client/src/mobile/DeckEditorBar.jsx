/**
 * DeckEditorBar.jsx — client/src/mobile/DeckEditorBar.jsx
 *
 * The bottom bar shown while the phone deck is in Edit Layout mode (Phase 4,
 * Tasks 4.3a + 4.3b). Task 4.3a shipped the deck-level shell — [Done] to discard
 * and exit, [Save] to replay the draft diff to the host. Task 4.3b adds the
 * per-item toolbar for the selected tile: size segments, [Move to page ▸], and
 * [Remove from page] (which detaches to Unfiled, never deletes). The final
 * polish adds one DECK-LEVEL group, [Pages ▸], whose Earlier / Later buttons move
 * a visible page inside the draft's page order — no host write any sooner than
 * Save, and it renders even when no tile is selected.
 *
 * It is a `flexShrink: 0` row placed after the deck and the page dots, so it
 * sits below both rather than covering them. The dots and the rail are the only
 * page-switch affordances left while editing (the deck-level swipe handler is
 * suppressed), so an overlay bar that hid them would make a multi-page deck
 * impossible to edit page-by-page. It still consumes no grid *cell*: the deck's
 * own CSS grid is untouched — the container merely gets shorter, and
 * useDeckLayout re-measures it, which is exactly what that hook exists for.
 *
 * The toolbar controls all live in THIS bar, never inside a tile, so the tile
 * stays the sole dnd-kit drag handle (`dragHandleProps` is not threaded into the
 * bar). The `dirty` gate on [Save] is unchanged from 4.3a.
 */
import { useState } from "react";
import { TILE_SIZES, spanFor } from "../layout/deckLayout.js";
import { visibleDeckPages } from "../layout/deckPages.js";

// The four engine sizes, drawn as short "1×1 … 2×2" labels. The label mirrors the
// grid span exactly (width×height) so a 1x2 (tall) reads differently from a 2x1
// (wide) even though both span two cells.
const sizeLabel = (size) => size.replace("x", "×");

function SegmentButton({ active, disabled, label, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 30,
        minWidth: 40,
        padding: "0 8px",
        borderRadius: 9,
        border: active
          ? "1px solid #3d8fd6"
          : "1px solid rgba(255,255,255,0.12)",
        background: active
          ? "rgba(61,143,214,0.28)"
          : disabled
            ? "rgba(255,255,255,0.02)"
            : "rgba(255,255,255,0.06)",
        color: active ? "#eaf3fb" : disabled ? "#43434d" : "#c9c9d4",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.6 : 1,
        transition: "background 0.12s ease, border-color 0.12s ease",
      }}
    >
      {label}
    </button>
  );
}

// `disabled` mirrors SegmentButton's treatment: the button is a real disabled
// control (no click, no focus action), and the muted fill/color/opacity say so.
// Page reordering needs it — "Earlier" on the first page and "Later" on the last
// are dead ends, and shiftPage returns the SAME draft for them anyway.
function ToolButton({ label, active, disabled, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        height: 30,
        padding: "0 12px",
        borderRadius: 9,
        border: active
          ? "1px solid rgba(61,143,214,0.5)"
          : "1px solid rgba(255,255,255,0.12)",
        background: active ? "rgba(61,143,214,0.2)" : "rgba(255,255,255,0.06)",
        color: disabled ? "#43434d" : "#c9c9d4",
        fontSize: 12,
        fontWeight: 600,
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </button>
  );
}

// `selected` is the draft row the toolbar acts on (already normalized by App so
// it always carries a composite `key` = `${kind}:${id}`, the layoutDraft op id).
// Every callback is passed that composite key; App resolves it back to a bare
// {kind,id} for the wire via diffDraft, so the bar never touches host payloads.
export default function DeckEditorBar({
  editMode,
  dirty,
  onDone,
  onSave,
  selected = null,
  layout = null,
  pages = [],
  // FEATURE: Page reordering — the VISIBLE pages in DRAFT order (App's `pagerPages`),
  // so the list and the dots always read the same sequence while editing.
  orderedPages = [],
  currentPage = null,
  onResize,
  onMoveToPage,
  onDetach,
  onShiftPage = null,
}) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(false);
  if (!editMode) return null;

  const id = selected?.key ?? null;
  // A 2-wide span (2x1, 2x2) needs at least two grid columns. The engine's
  // `cols` is its authoritative answer on whether two cells + a gap fit the
  // measured width (cols is capped by `floor((width+gap)/(2*minCell+gap))`), so
  // `cols >= 2` already encodes the "2*cell + gap <= deckInnerWidth" test. When
  // the deck has not been measured yet (`layout` null) every segment is disabled.
  const wideFits = !!layout && layout.cols >= 2;

  // Visible move targets: real pages that are neither hidden nor the page the
  // tile is already on. The Unfiled target is offered separately and routes to
  // onDetach (not onMoveToPage) so a detach re-parents to the lazy Unfiled page.
  // Built from `orderedPages` (the SAME draft-order list the Pages panel below
  // shows, already visible-only) so the two never disagree on screen mid-draft;
  // `pages` alone is the host order and lags the draft.
  const moveTargets = (
    Array.isArray(orderedPages) ? orderedPages : visibleDeckPages(pages)
  ).filter((p) => p.id !== currentPage);

  const closeMove = () => setMoveOpen(false);

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        flexShrink: 0,
        // Horizontal insets only: the parent column already pads the bottom safe
        // area, so repeating it here would double up under the system nav bar.
        padding:
          "8px max(env(safe-area-inset-right), 14px) 8px max(env(safe-area-inset-left), 14px)",
        boxSizing: "border-box",
        borderTop: "1px solid #2a2a2e",
        background: "linear-gradient(180deg, #161618 0%, #1c1c1f 100%)",
      }}
    >
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

      {selected && id && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 8,
            minWidth: 0,
          }}
        >
          {/* Size segments — current size highlighted, 2-wide spans disabled
              when the engine reports the deck cannot fit two columns. */}
          {TILE_SIZES.map((size) => {
            const wide = spanFor(size).cols > 1;
            return (
              <SegmentButton
                key={size}
                label={sizeLabel(size)}
                active={selected.size === size}
                disabled={!layout || (wide && !wideFits)}
                onClick={() => onResize?.(id, size)}
              />
            );
          })}

          <ToolButton
            label="Move to page ▸"
            active={moveOpen}
            onClick={() => setMoveOpen((o) => !o)}
          />
          <ToolButton
            label="Remove from page"
            onClick={() => {
              closeMove();
              onDetach?.(id);
            }}
          />
        </div>
      )}

      {selected && id && moveOpen && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: 6,
            width: "100%",
            padding: "6px 8px",
            borderRadius: 10,
            border: "1px solid rgba(255,255,255,0.1)",
            background: "rgba(255,255,255,0.03)",
            boxSizing: "border-box",
          }}
        >
          {moveTargets.length === 0 && (
            <span style={{ fontSize: 11, color: "#55555f" }}>
              No other pages
            </span>
          )}
          {moveTargets.map((p) => (
            <ToolButton
              key={p.id}
              label={p.name || "Page"}
              onClick={() => {
                closeMove();
                onMoveToPage?.(id, p.id);
              }}
            />
          ))}
          {/* The detach target lives in the same list so "move it off this page"
              is one gesture family; it routes to onDetach, never onMoveToPage. */}
          <ToolButton
            label="Unfiled (detached)"
            onClick={() => {
              closeMove();
              onDetach?.(id);
            }}
          />
        </div>
      )}

      <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
        <button
          type="button"
          onClick={onDone}
          style={{
            height: 38,
            minWidth: 84,
            padding: "0 18px",
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.14)",
            background: "rgba(255,255,255,0.06)",
            color: "#c9c9d4",
            fontSize: 14,
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Done
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty}
          style={{
            height: 38,
            minWidth: 84,
            padding: "0 18px",
            borderRadius: 12,
            border: "none",
            background: dirty
              ? "linear-gradient(135deg, #3d8fd6, #3d8fd6)"
              : "rgba(255,255,255,0.05)",
            color: dirty ? "#fff" : "#55555f",
            fontSize: 14,
            fontWeight: 700,
            cursor: dirty ? "pointer" : "default",
            transition: "background 0.15s ease, color 0.15s ease",
          }}
        >
          Save
        </button>
      </div>
    </div>
  );
}

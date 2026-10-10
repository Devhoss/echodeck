/**
 * DeckEditorBar.jsx — client/src/mobile/DeckEditorBar.jsx
 *
 * The bottom bar shown while the phone deck is in Edit Layout mode (Phase 4,
 * Tasks 4.3a + 4.3b). Task 4.3a shipped the deck-level shell — [Done] to discard
 * and exit, [Save] to replay the draft diff to the host. Task 4.3b adds the
 * per-item toolbar for the selected tile: size segments, [Move to page ▸], and
 * [Remove from page] (which detaches to Unfiled, never deletes).
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

function ToolButton({ label, active, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 30,
        padding: "0 12px",
        borderRadius: 9,
        border: active
          ? "1px solid rgba(61,143,214,0.5)"
          : "1px solid rgba(255,255,255,0.12)",
        background: active ? "rgba(61,143,214,0.2)" : "rgba(255,255,255,0.06)",
        color: "#c9c9d4",
        fontSize: 12,
        fontWeight: 600,
        cursor: "pointer",
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
  currentPage = null,
  onResize,
  onMoveToPage,
  onDetach,
}) {
  const [moveOpen, setMoveOpen] = useState(false);
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
  const moveTargets = pages.filter((p) => !p.hidden && p.id !== currentPage);

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

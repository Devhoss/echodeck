/**
 * DeckEditorBar.jsx — client/src/mobile/DeckEditorBar.jsx
 *
 * The bottom bar shown while the phone deck is in Edit Layout mode (Phase 4,
 * Task 4.3a). This sub-task ships the minimal shell only: the two deck-level
 * actions that drive the draft lifecycle — [Done] to discard and exit, [Save] to
 * replay the draft diff to the host.
 *
 * It is a `flexShrink: 0` row placed after the deck and the page dots, so it
 * sits below both rather than covering them. The dots and the rail are the only
 * page-switch affordances left while editing (the deck-level swipe handler is
 * suppressed), so an overlay bar that hid them would make a multi-page deck
 * impossible to edit page-by-page. It still consumes no grid *cell*: the deck's
 * own CSS grid is untouched — the container merely gets shorter, and
 * useDeckLayout re-measures it, which is exactly what that hook exists for.
 *
 * Task 4.3b extends THIS file with the per-item toolbar (size segments, Move to
 * page, Remove from page) driven by the selected tile; the props for that
 * (`selected`, `onResize`, `onMoveToPage`, `onDetach`) are deliberately not
 * added yet, so the 4.3a surface stays exactly Done/Save.
 */

// The two buttons are the whole 4.3a contract. `dirty` gates Save: it is the
// structural draft-vs-base difference computed in App (not a reference compare),
// so Done stays always-clickable (discarding an untouched draft is harmless)
// while Save is disabled until something actually changed.
export default function DeckEditorBar({ editMode, dirty, onDone, onSave }) {
  if (!editMode) return null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
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
  );
}

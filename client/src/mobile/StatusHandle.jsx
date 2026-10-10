// FEATURE: Mobile customization (Task 5.1) — the collapsed status handle.
// It replaces the old 44-px top bar (logo + "EchoDeck" + CPU/RAM/time pills +
// volume pill + status pill + disconnect button) with a 28-px strip that keeps
// only what must stay permanently on screen: the app icon, a connection dot,
// and an optional mic-active marker. Everything numeric moved into the
// ControlSheet — that reclaimed strip is the whole point of issue #9. The safe
// area lives on the outer flex column in App.jsx (paddingTop env(safe-area-
// inset-top)), so the handle itself is exactly 28 px.
//
// The whole strip is ONE button (`aria-expanded` + `aria-controls="deck-
// control-sheet"`); a transparent ::after grows its hit area to the 44-px
// accessibility minimum without changing the 28-px layout height.
//
// Reveal-on-intent (owner rule): the pull chevron starts at opacity 0 and its
// 16-px slot is always reserved, so nothing reflows when it fades in. It
// appears only while a finger is down on the handle (a touch anywhere on the
// strip means "I intend to pull or open") and stays shown, rotated, while the
// sheet is open as the tap-to-close affordance. No hover state — mobile-only
// surface.
import { useState } from "react";
import deck from "/deck-icon.png";
import { ActionIcon, Icon } from "../icons.jsx";

export default function StatusHandle({
  isConnected,
  micActive,
  sheetOpen,
  onToggle,
}) {
  // "A downward gesture is active" is approximated the simplest correct way:
  // while the handle itself is being touched. See the reveal rule above.
  const [pulling, setPulling] = useState(false);
  const chevronVisible = sheetOpen || pulling;

  return (
    <div
      data-status-handle
      style={{
        height: 28,
        flexShrink: 0,
        display: "flex",
        background: "linear-gradient(180deg, #1c1c1f 0%, #161618 100%)",
        borderBottom: "1px solid #2a2a2e",
      }}
    >
      {/* Grows the button's tappable box from 28 px to 44 px (±8 px vertical)
          without touching layout. The overlap into the sheet's caption row is
          harmless — that row holds no controls. */}
      <style>{`
        .deck-status-hit { position: relative; }
        .deck-status-hit::after {
          content: "";
          position: absolute;
          top: -8px;
          bottom: -8px;
          left: 0;
          right: 0;
        }
      `}</style>

      <button
        type="button"
        className="deck-status-hit"
        aria-expanded={sheetOpen}
        aria-controls="deck-control-sheet"
        aria-label={sheetOpen ? "Close host controls" : "Open host controls"}
        onClick={onToggle}
        onPointerDown={() => setPulling(true)}
        onPointerUp={() => setPulling(false)}
        onPointerCancel={() => setPulling(false)}
        style={{
          flex: 1,
          minWidth: 0,
          height: "100%",
          display: "flex",
          alignItems: "center",
          gap: 6,
          border: "none",
          background: "transparent",
          cursor: "pointer",
          padding: 0,
          paddingLeft: "max(env(safe-area-inset-left), 16px)",
          paddingRight: "max(env(safe-area-inset-right), 16px)",
        }}
      >
        <img
          src={deck}
          width={20}
          height={20}
          alt=""
          style={{ borderRadius: 6, flexShrink: 0, display: "block" }}
          draggable={false}
        />

        {/* Connection dot — color/animation relocated verbatim from the old
            header pill's <span>; the words live in the ControlSheet pill. */}
        <span
          style={{
            width: 6,
            height: 6,
            flexShrink: 0,
            borderRadius: "50%",
            background: isConnected ? "#4ade80" : "#f87171",
            boxShadow: isConnected ? "0 0 6px #4ade80" : "0 0 6px #f87171",
            animation: isConnected ? "pulse 2s infinite" : "none",
          }}
        />

        {/* Mic state, when the phone is listening/unmuted — an icon only, no
            level numbers (it never had a header pill before either). */}
        {micActive && (
          <ActionIcon
            name="mic"
            size={13}
            style={{ display: "block", flexShrink: 0, color: "#4ade80" }}
          />
        )}

        {/* Reserved-width chevron slot (hard requirement: 16 px at rest so no
            text jumps when the glyph fades in). */}
        <span
          aria-hidden="true"
          style={{
            width: 16,
            flexShrink: 0,
            marginLeft: "auto",
            display: "flex",
            justifyContent: "center",
            opacity: chevronVisible ? 1 : 0,
            transform: sheetOpen ? "rotate(180deg)" : "none",
            transition: "opacity 0.15s ease, transform 0.15s ease",
          }}
        >
          <Icon name="chevronDown" size={14} style={{ color: "#77777f" }} />
        </span>
      </button>
    </div>
  );
}

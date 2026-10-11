// FEATURE: Mobile customization (Task 5.2) — the pull-down control sheet.
// Everything the old 44-px header used to pin permanently on screen now lives
// here, revealed on demand by StatusHandle: the CPU/RAM/time StatPills (moved
// here from App.jsx, not duplicated), the connection pill and the
// Disconnect button (relocated verbatim), plus the Edit Layout entry.
// Volume and mic live as deck buttons only — the sheet's level rows were
// dropped in the final layout polish (phone = dashboard, desktop = config),
// and detailed layout settings moved to the desktop modal for the same split.
//
// It is a PUSH-DOWN sheet, never an overlay: it sits in the same outer flex
// column as the handle, directly above the deck, so opening it shrinks the
// deck's box and `useDeckLayout`'s ResizeObserver re-fits the grid (spec §3
// requirement 6). `aria-modal="false"` for the same reason — the deck stays
// live behind it.
//
// Reduced motion: prefers-reduced-motion is already globally handled by
// client/src/index.css:183-192 (`transition-duration: 0.01ms !important` on
// everything), so no JS `matchMedia` guard is needed — the inline
// `transition: transform …` styles below are automatically clamped.
import { useEffect, useRef, useState } from "react";
import disconnect from "/disconnect.svg";
import { Icon } from "../icons.jsx";

// FEATURE: System stats — pill component (moved here from App.jsx together
// with its only remaining consumer; the header that used it is now the handle).
function StatPill({ label, value, warn }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        background: warn ? "#2e1a0d" : "#1a1a22",
        border: `1px solid ${warn ? "#5c3a1a" : "#2a2a35"}`,
        borderRadius: 12,
        padding: "2px 7px",
        fontSize: 9,
        fontVariantNumeric: "tabular-nums",
        transition: "all 0.5s ease",
      }}
    >
      {label && <span style={{ color: "#444" }}>{label}</span>}
      <span style={{ color: warn ? "#fb923c" : "#888" }}>{value}</span>
    </div>
  );
}

export default function ControlSheet({
  id,
  open,
  onClose,
  stats,
  isConnected,
  status,
  handleDisconnect,
  disconnectActive,
  setDisconnectActive,
  editModeApiRef,
}) {
  const sheetRef = useRef(null);
  // A closed-by-outside-tap pointer sequence gets swallowed for its pointerdown
  // AND its trailing click (Task 5.3, Rule 6): canceling pointerdown suppresses
  // the browser's compatibility click on Chromium/WebKit, but the click guard
  // below is permanent and engine-independent belt-and-braces — the dismiss
  // listener unmounts the moment `open` flips false, so a guard tied to `open`
  // could never survive to catch the click that follows the pointerup.
  //
  // Fix round 1 (Important #1): the arm is SELF-INVALIDATING. On engines that
  // honor the spec the dismissing click never arrives, so the slot would stay
  // armed — and because mouse pointerId is constant (1), the user's NEXT mouse
  // click within 1s would match and be silently swallowed. Any fresh capture
  // pointerdown therefore clears the slot FIRST: a new pointer sequence proves
  // the old trailing click will never arrive. The dismissing sequence itself
  // is unaffected: its click fires before any new pointerdown, and the
  // permanent clear runs before the (open-only) arm site, never after it.
  const swallowRef = useRef(null);
  useEffect(() => {
    const onDocPointerDownClear = () => {
      // Must be registered (and thus run) BEFORE the open-gated arm listener
      // below, so an outside-tap dismiss still clears any stale slot and then
      // arms fresh in the same event.
      swallowRef.current = null;
    };
    const onDocClick = (e) => {
      const s = swallowRef.current;
      if (!s) return;
      swallowRef.current = null;
      if (e.pointerId === s.pointerId && Date.now() - s.at < 1000) {
        e.stopPropagation();
        e.preventDefault();
      }
    };
    document.addEventListener("pointerdown", onDocPointerDownClear, true);
    document.addEventListener("click", onDocClick, true);
    return () => {
      document.removeEventListener("pointerdown", onDocPointerDownClear, true);
      document.removeEventListener("click", onDocClick, true);
    };
  }, []);

  // Up-swipe-to-close tracking (the sheet is push-down, so the deck keeps its
  // own swipe handlers — this one lives only on the sheet box).
  const [swipeStartY, setSwipeStartY] = useState(null);

  useEffect(() => {
    if (!open) return;
    sheetRef.current?.focus({ preventScroll: true });
    // Outside tap closes. The handle is excluded — its own onClick toggles,
    // and closing here too would immediately reopen. Modal overlays
    // ([data-outside-tap-exempt]) are excluded too: they sit ABOVE the sheet,
    // own their dismissal, and must not get one-swallowed.
    const onDocPointerDown = (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;
      if (sheetRef.current?.contains(el)) return;
      if (el.closest("[data-status-handle]")) return;
      if (el.closest("[data-outside-tap-exempt]")) return;
      // Gesture arbitration (Task 5.3): swallow the dismissing sequence in the
      // capture phase so nothing below the sheet — deck swipe, tile press,
      // hold-to-confirm — ever sees it.
      e.stopPropagation();
      e.preventDefault();
      swallowRef.current = { pointerId: e.pointerId, at: Date.now() };
      onClose();
    };
    document.addEventListener("pointerdown", onDocPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onDocPointerDown, true);
  }, [open, onClose]);

  // Escape closes; Tab is trapped so the sheet behaves like a dialog while it
  // is expanded (and `inert` below removes it from the tab order when closed).
  const onKeyDown = (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !sheetRef.current) return;
    const items = [
      ...sheetRef.current.querySelectorAll("button, input, a[href]"),
    ].filter((el) => !el.disabled);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (
      e.shiftKey &&
      (active === first || active === sheetRef.current)
    ) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onPointerDown = (e) => {
    setSwipeStartY(e.clientY);
  };

  const onPointerUp = (e) => {
    if (swipeStartY === null) return;
    const dy = swipeStartY - e.clientY;
    setSwipeStartY(null);
    if (dy > 24) onClose(); // deliberate up-swipe dismisses the sheet
  };

  const actionButtonStyle = {
    display: "flex",
    alignItems: "center",
    gap: 5,
    // height 24 to match the connection pill and the Disconnect button already
    // in this row, so the sheet's rows sit on one rhythm.
    height: 24,
    boxSizing: "border-box",
    padding: "0 10px",
    background: "#1a1a22",
    border: "1px solid #2a2a35",
    borderRadius: 12,
    color: "#c0c0cc",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  };

  return (
    <div
      id={id}
      ref={sheetRef}
      role="dialog"
      aria-modal="false"
      aria-label="Host controls"
      tabIndex={-1}
      // React 19 boolean `inert`: collapsed, the sheet takes no space and is
      // removed from focus/tab order, so its controls cannot be reached.
      inert={!open}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => setSwipeStartY(null)}
      style={{
        flexShrink: 0,
        overflow: "hidden",
        outline: "none",
        // Push-down animation: the box grows in the flex column (never fixed/
        // absolute), so the deck is re-measured through the ResizeObserver.
        maxHeight: open ? "min(55%, 220px)" : 0,
        opacity: open ? 1 : 0,
        transform: `translateY(${open ? 0 : -6}px)`,
        transition:
          "max-height 0.18s ease, opacity 0.18s ease, transform 0.18s ease",
        background: "linear-gradient(180deg, #18181c 0%, #141417 100%)",
        borderBottom: open ? "1px solid #2a2a2e" : "1px solid transparent",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div
        style={{
          flexShrink: 0,
          padding: "6px max(env(safe-area-inset-left), 16px) 8px max(env(safe-area-inset-right), 16px)",
          display: "flex",
          flexDirection: "column",
          gap: 5,
        }}
      >
        {/* Caption: local stats are about THIS machine (the host the phone is
            paired to), explicitly not the Homelab — remote numbers live only
            in widget tiles, which carry their own source label. */}
        <div
          style={{
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.6,
            textTransform: "uppercase",
            color: "#55556a",
          }}
        >
          EchoDeck host — this computer
        </div>

        {/* The three remaining rows stack in a single column (see the flex
            `.deck-sheet-grid` below); the narrow two-column trick and its
            span-all overrides are gone now that the sheet fits the 220-px
            landscape cap on its own. */}
        <div className="deck-sheet-grid">
          {/* FEATURE: System stats — CPU / RAM / clock pills (relocated from
              the header, same fixed slot widths, so nothing jumps). */}
          {stats && (
            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <StatPill
                label="CPU"
                value={`${stats.cpu}%`}
                warn={stats.cpu > 80}
              />
              <StatPill
                label="RAM"
                value={`${stats.ramUsed}/${stats.ramTotal}G`}
                warn={stats.ramUsed / stats.ramTotal > 0.85}
              />
              <StatPill label="" value={stats.time} />
            </div>
          )}

          {/* Connection status pill + Disconnect button + Edit Layout —
              relocated verbatim from the old header (the confirm modal itself
              stays in App.jsx; only the trigger moved here). */}
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                height: 24,
                boxSizing: "border-box",
                background: isConnected ? "#0d2e1a" : "#2e0d0d",
                border: `1px solid ${isConnected ? "#1a5c32" : "#5c1a1a"}`,
                borderRadius: 20,
                padding: "3px 10px",
                fontSize: 11,
                color: isConnected ? "#4ade80" : "#f87171",
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: isConnected ? "#4ade80" : "#f87171",
                  boxShadow: isConnected
                    ? "0 0 6px #4ade80"
                    : "0 0 6px #f87171",
                  animation: isConnected ? "pulse 2s infinite" : "none",
                }}
              />
              {isConnected
                ? "Connected"
                : status === "connecting"
                  ? "Connecting…"
                  : "Offline"}
            </div>

            <button
              title="Disconnect"
              onPointerDown={(e) => {
                e.preventDefault();
                setDisconnectActive(true);
                handleDisconnect();
              }}
              onPointerUp={() => setDisconnectActive(false)}
              onPointerCancel={() => setDisconnectActive(false)}
              style={{
                background: disconnectActive ? "#c42d2d" : "#ed5656",
                border: "none",
                borderRadius: 8,
                cursor: "pointer",
                transition: "background 0.15s ease",
                flexShrink: 0,
                height: 24,
                boxSizing: "border-box",
                padding: "0 8px", // horizontal only, vertical handled by height
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <img
                src={disconnect}
                width={14}
                height={14}
                style={{ display: "block" }}
              />
            </button>

            {/* Edit Layout (Phase 4 entry point) — the sheet's only action
                button: detailed layout settings live in the desktop's Layout
                Settings modal now (phone = dashboard, desktop = config). */}
            <button
              type="button"
              style={actionButtonStyle}
              onClick={() => {
                editModeApiRef.current?.toggleEditMode();
                onClose();
              }}
            >
              <Icon name="drag" size={12} />
              Edit Layout
            </button>
          </div>
        </div>
      </div>

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
    </div>
  );
}

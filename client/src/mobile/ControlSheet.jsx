// FEATURE: Mobile customization (Task 5.2) — the pull-down control sheet.
// Everything the old 44-px header used to pin permanently on screen now lives
// here, revealed on demand by StatusHandle: the CPU/RAM/time StatPills (moved
// here from App.jsx, not duplicated), the VolumePill display logic (extracted
// and upgraded to slider + minus/plus + mute), the connection pill and the
// Disconnect button (relocated verbatim), plus the Edit Layout entry and the
// Phase-6 Settings placeholder.
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
import { ActionIcon, Icon } from "../icons.jsx";
import { sliderSetArgs } from "./volumeTap.js";

// One tap of the sheet's minus/plus keys. Matches VOLUME_STEP_DEFAULT in
// App.jsx (and the host's fallback), because the sheet has no per-button step
// to read from a tile config.
const SHEET_HOLD_STEP = 5;

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

// FEATURE: Volume controls — one level row (speaker or mic). The minus/plus
// keys hold-to-repeat with the exact same WS protocol the tile volume keys use
// (`startVolumeHold`/`stopVolumeHold`); the hold works there because the finger
// stays down (start tick fires, interval installs, stop clears later). The
// slider is different: a drag/tap emits `change` events, and each now sends one
// absolute `volume_set` frame via `sliderSetArgs` + `sendVolumeSet`. The old
// start/stop pair raced the host's async volume read and landed zero change
// (see volumeTap.js). The mute button sends the sheet-only
// `mute_toggle`/`mic_mute_toggle` frame; every level/mute state comes back
// through the existing broadcast.
function LevelRow({
  kind,
  label,
  value,
  muted,
  startVolumeHold,
  stopVolumeHold,
  sendMuteToggle,
  sendVolumeSet,
  className,
}) {
  const level = value ?? 0;
  // While a `volume_set` is in flight the `value` prop is still the pre-change
  // echo, so the range thumb would rubber-band back mid-drag. Latch the last
  // level we SENT and drive the input from it until the broadcast echo returns.
  // This is derived state — reset it during render when the echoed prop changes
  // (React's blessed pattern), which avoids both a render-time ref read and a
  // setState-in-effect, each of which `react-hooks` lint forbids.
  const [pending, setPending] = useState({ echoed: value, level: null });
  if (pending.echoed !== value) {
    setPending({ echoed: value, level: null });
  }
  const sliderValue = pending.level ?? (muted ? 0 : level);
  const icon =
    kind === "mic"
      ? muted
        ? "mic-off"
        : "mic"
      : muted
        ? "volume-x"
        : level > 50
          ? "volume-2"
          : "volume-1";

  const keyButtonStyle = {
    width: 28,
    height: 28,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#1a1a22",
    border: "1px solid #2a2a35",
    borderRadius: 8,
    color: "#aaa",
    cursor: "pointer",
    padding: 0,
  };

  return (
    <div
      className={className}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        minWidth: 0,
      }}
    >
      <ActionIcon
        name={icon}
        size={14}
        style={{
          flexShrink: 0,
          color: muted ? "#f87171" : "#888",
        }}
      />
      <span
        style={{
          width: 26,
          flexShrink: 0,
          fontSize: 9,
          color: "#666",
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </span>

      <button
        type="button"
        aria-label={`${label} down`}
        style={keyButtonStyle}
        onPointerDown={() => startVolumeHold("down", SHEET_HOLD_STEP, kind)}
        onPointerUp={stopVolumeHold}
        onPointerCancel={stopVolumeHold}
      >
        <span style={{ fontSize: 15, lineHeight: 1 }}>−</span>
      </button>

      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={sliderValue}
        aria-label={`${label} level`}
        onChange={(e) => {
          const frame = sliderSetArgs(kind, e.target.value);
          if (!frame) return;
          // Absolute set: latch the value we send so the thumb tracks the
          // finger until the host echo returns, then hand the frame to the WS.
          setPending({ echoed: value, level: frame.level });
          sendVolumeSet(frame.level, frame.target);
        }}
        style={{
          flex: 1,
          minWidth: 48,
          accentColor: "#3b82f6",
          height: 24,
        }}
      />

      <button
        type="button"
        aria-label={`${label} up`}
        style={keyButtonStyle}
        onPointerDown={() => startVolumeHold("up", SHEET_HOLD_STEP, kind)}
        onPointerUp={stopVolumeHold}
        onPointerCancel={stopVolumeHold}
      >
        <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
      </button>

      <button
        type="button"
        aria-label={`${label} mute`}
        aria-pressed={muted}
        style={{
          ...keyButtonStyle,
          background: muted ? "#2e0d0d" : "#1a1a22",
          border: `1px solid ${muted ? "#5c1a1a" : "#2a2a35"}`,
        }}
        onClick={() => sendMuteToggle(kind)}
      >
        <ActionIcon
          name={icon}
          size={14}
          style={{ color: muted ? "#f87171" : "#aaa" }}
        />
      </button>

      <span
        style={{
          width: 34,
          flexShrink: 0,
          textAlign: "right",
          fontSize: 10,
          color: muted ? "#f87171" : "#888",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value === null || value === undefined ? "—" : muted ? "—" : `${value}%`}
      </span>
    </div>
  );
}

export default function ControlSheet({
  id,
  open,
  onClose,
  stats,
  volume,
  muted,
  micVolume,
  micMuted,
  isConnected,
  status,
  startVolumeHold,
  stopVolumeHold,
  sendMuteToggle,
  sendVolumeSet,
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
    // The slider is a vertical-travel thief: never start a swipe from it.
    if (e.target instanceof Element && e.target.closest("input")) {
      setSwipeStartY(null);
      return;
    }
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
    height: 26,
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
      }}
    >
      <div
        style={{
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

        {/* A layout constraint, not a device rule: below 500 px the content
            flows in two columns so it still fits the 220-px landscape cap
            without internal scroll. */}
        <div className="deck-sheet-grid">
          {/* FEATURE: System stats — CPU / RAM / clock pills (relocated from
              the header, same fixed slot widths, so nothing jumps). */}
          {stats && (
            <div
              className="deck-sheet-span-all"
              style={{ display: "flex", alignItems: "center", gap: 5 }}
            >
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

          {/* Volume + mic rows span BOTH columns in the narrow (<500px) flow.
              Their min-content is ~236px (icon+label+readout with
              flexShrink:0, plus a 48px slider floor), which cannot fit a ~172px
              half-column on a 390px phone — the mute button and readout would be
              clipped by the sheet's overflow:hidden. Full-width rows remove the
              clip while the STATS row keeps the 2-column reclaim the brief
              wanted. Above 499px the grid is single-column, so the class is a
              no-op. */}
          <LevelRow
            kind="speaker"
            label="Vol"
            value={volume}
            muted={muted}
            className="deck-sheet-span-all"
            startVolumeHold={startVolumeHold}
            stopVolumeHold={stopVolumeHold}
            sendMuteToggle={sendMuteToggle}
            sendVolumeSet={sendVolumeSet}
          />

          <LevelRow
            kind="mic"
            label="Mic"
            value={micVolume}
            muted={micMuted}
            className="deck-sheet-span-all"
            startVolumeHold={startVolumeHold}
            stopVolumeHold={stopVolumeHold}
            sendMuteToggle={sendMuteToggle}
            sendVolumeSet={sendVolumeSet}
          />

          {/* Connection status pill + Disconnect button — relocated verbatim
              from the old header (the confirm modal itself stays in App.jsx;
              only the trigger moved here). */}
          <div
            className="deck-sheet-span-all"
            style={{ display: "flex", alignItems: "center", gap: 6 }}
          >
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

            {/* Edit Layout (Phase 4 entry point) and the Phase-6 placeholder. */}
            <button
              type="button"
              style={{ ...actionButtonStyle, marginLeft: "auto" }}
              onClick={() => {
                editModeApiRef.current?.toggleEditMode();
                onClose();
              }}
            >
              <Icon name="drag" size={12} />
              Edit Layout
            </button>

            <a
              href="#settings"
              aria-disabled="true"
              title="Phase 6 will open layout preferences here"
              onClick={(e) => {
                // Placeholder until Phase 6: non-interactive, but still stop
                // the href from jumping the page / writing #settings into the
                // URL. No toast system exists yet, so this is a bare no-op.
                e.preventDefault();
              }}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                fontSize: 11,
                fontWeight: 600,
                color: "#8888a0",
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              <Icon name="settings" size={12} />
              Settings
            </a>
          </div>
        </div>
      </div>

      <style>{`
        .deck-sheet-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 5px 14px;
          align-items: center;
        }
        @media (max-width: 499px) {
          .deck-sheet-grid { grid-template-columns: 1fr 1fr; }
          .deck-sheet-span-all { grid-column: 1 / -1; }
        }
      `}</style>
    </div>
  );
}

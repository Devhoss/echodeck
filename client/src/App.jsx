import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import ReconnectingWebSocket from "reconnecting-websocket";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { useSortable } from "@dnd-kit/sortable";
import deck from "/deck-icon.png";
import DesktopApp from "./desktop/DesktopApp.jsx";
import { CSS } from "@dnd-kit/utilities";
import {
  isPaired,
  setPairConfig,
  loadPairConfig,
  getWsUrl,
  isElectron,
} from "./constants.js";
import PairingScreen from "./PairingScreen.jsx";
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import ConfigUI from "./ConfigUI.jsx";

const globalStyles = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50%       { opacity: 0.4; }
  }
  @keyframes ripple {
    0%   { transform: scale(0); opacity: 0.45; }
    100% { transform: scale(2.8); opacity: 0; }
  }
  @keyframes toggleGlow {
    0%, 100% { opacity: 0.7; }
    50%       { opacity: 1; }
  }
  * { -webkit-tap-highlight-color: transparent; }
  html, body {
    overflow: hidden;
    height: 100%;
  }
`;

// FEATURE: Volume controls — which action types are volume-related
const VOLUME_ACTIONS = new Set([
  "volume_up",
  "volume_down",
  "volume_set",
  "volume_mute",
]);
const VOLUME_HOLD_ACTIONS = new Set(["volume_up", "volume_down"]);

// FEATURE: Soundboard — reusable audio player
// Keeps a single AudioContext alive for the session (avoids mobile autoplay blocks).
// On iOS/Android WebView the AudioContext must be resumed after a user gesture —
// we do that inside pressButton which is always triggered by a tap.
let _audioCtx = null;
function getAudioContext() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return _audioCtx;
}

async function playSound(dataUrl) {
  if (!dataUrl) return;
  try {
    const ctx = getAudioContext();
    // Resume in case the context was suspended (required on iOS)
    if (ctx.state === "suspended") await ctx.resume();

    // Fetch the base64 data URL as an ArrayBuffer and decode it
    const response = await fetch(dataUrl);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // Fallback: plain <audio> element (works for mp3/wav on most Android WebViews)
    try {
      const audio = new Audio(dataUrl);
      audio.volume = 1;
      await audio.play();
    } catch (e2) {
      console.warn("Sound playback failed:", e2.message);
    }
  }
}

export default function App() {
  const [paired, setPaired] = useState(() => isPaired());
  const [buttons, setButtons] = useState([]);
  const [pages, setPages] = useState([]);
  const [currentPage, setCurrentPage] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [pressing, setPressing] = useState(null);
  const [view, setView] = useState("deck");
  // FEATURE: System stats
  const [stats, setStats] = useState(null);
  // FEATURE: Volume controls — live volume + mute state
  const [volume, setVolume] = useState(null);
  const [muted, setMuted] = useState(false);

  const wsRef = useRef(null);
  const lastMessageAtRef = useRef(0);
  const pageButtonsCacheRef = useRef(new Map());
  const reorderTimer = useRef(null);
  const [pairedHost, setPairedHost] = useState(() => {
    loadPairConfig();
    return getWsUrl(); // non-null if already paired
  });

  useEffect(() => {
    const wsUrl = getWsUrl();
    if (!wsUrl) return;

    console.log("isElectron", isElectron());
    console.log("location", window.location.href);
    console.log("hostname", window.location.hostname);
    console.log("ws", getWsUrl());

    lastMessageAtRef.current = Date.now();
    const ws = new ReconnectingWebSocket(getWsUrl(), [], {
      maxRetryTime: 10000,
      reconnectionDelayGrowFactor: 1.5,
    });

    const onOpen = () => {
      console.log("WS open", getWsUrl());
      setStatus("connected");
    };
    const onClose = (e) => {
      console.log("WS close", e.code, e.reason);
      setStatus("disconnected");
    };
    const onError = (e) => {
      console.log("WS error", e);
      setStatus("disconnected");
    };
    const onMessage = (e) => {
      lastMessageAtRef.current = Date.now();
      const msg = JSON.parse(e.data);
      if (msg.t === "state") {
        setPages(msg.pages);
        setCurrentPage(msg.current_page);
        pageButtonsCacheRef.current.set(msg.current_page, msg.buttons);
        setButtons(msg.buttons);
      }
      if (msg.t === "update") {
        setButtons((prev) =>
          prev.map((b) => (b.id === msg.id ? { ...b, ...msg } : b)),
        );
      }
      // FEATURE: System stats — receive stats pushed from server every 3s
      if (msg.t === "stats") {
        setStats({
          cpu: msg.cpu,
          ramUsed: msg.ram_used,
          ramTotal: msg.ram_total,
          time: msg.time,
        });
        if (msg.volume !== null && msg.volume !== undefined)
          setVolume(msg.volume);
        if (msg.muted !== null && msg.muted !== undefined) setMuted(msg.muted);
      }
      // FEATURE: Volume controls — instant volume update
      if (msg.t === "volume") {
        if (msg.volume !== null && msg.volume !== undefined)
          setVolume(msg.volume);
        if (msg.muted !== null && msg.muted !== undefined) setMuted(msg.muted);
      }
      // FEATURE: Soundboard — server tells this client to play a sound
      // The server only sends this to the client that pressed the button,
      // so sound plays on the phone, not on every connected device.
      if (msg.t === "play_sound" && msg.sound_file) {
        playSound(msg.sound_file);
      }
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
    ws.addEventListener("message", onMessage);
    wsRef.current = ws;

    const reconnectIfStale = () => {
      const quietFor = Date.now() - lastMessageAtRef.current;
      if (document.visibilityState === "hidden") return;
      if (ws.readyState !== WebSocket.OPEN || quietFor > 8000) {
        setStatus("connecting");
        try {
          ws.reconnect?.(4000, "app resumed");
        } catch {
          ws.close();
        }
      }
    };

    const onVisibilityChange = () => reconnectIfStale();
    const onFocus = () => reconnectIfStale();
    const onPageShow = () => reconnectIfStale();

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    const staleSocketTimer = setInterval(reconnectIfStale, 5000);

    return () => {
      clearInterval(staleSocketTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("close", onClose);
      ws.removeEventListener("error", onError);
      ws.removeEventListener("message", onMessage);
      ws.close();
    };
  }, [pairedHost]);

  const pressButton = useCallback(async (id) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setStatus("connecting");
      wsRef.current?.reconnect?.(4000, "button press");
      return;
    }
    try {
      await Haptics.impact({ style: ImpactStyle.Heavy });
    } catch {
      navigator.vibrate?.(10);
    }
    setPressing(id);
    wsRef.current.send(JSON.stringify({ v: 1, t: "press", id }));
    setTimeout(() => setPressing(null), 150);
  }, []);

  // FEATURE: Volume controls — send hold_start when finger goes down on a vol button
  const startVolumeHold = useCallback((direction) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setStatus("connecting");
      wsRef.current?.reconnect?.(4000, "volume hold");
      return;
    }
    wsRef.current.send(
      JSON.stringify({ t: "volume_hold_start", direction, step: 2 }),
    );
  }, []);

  // FEATURE: Volume controls — send hold_stop when finger lifts
  const stopVolumeHold = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ t: "volume_hold_stop" }));
  }, []);

  const switchPage = useCallback((page_id) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setStatus("connecting");
      wsRef.current?.reconnect?.(4000, "switch page");
      return;
    }
    setCurrentPage(page_id);
    const cachedButtons = pageButtonsCacheRef.current.get(page_id);
    if (cachedButtons) setButtons(cachedButtons);
    wsRef.current.send(JSON.stringify({ v: 1, t: "switch_page", page_id }));
  }, []);

  const handleDragEnd = useCallback(
    (event) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      setButtons((prev) => {
        const oldIndex = prev.findIndex((b) => b.id === active.id);
        const newIndex = prev.findIndex((b) => b.id === over.id);
        const reordered = arrayMove(prev, oldIndex, newIndex).map((btn, i) => ({
          ...btn,
          position: i,
        }));
        if (currentPage)
          pageButtonsCacheRef.current.set(currentPage, reordered);
        clearTimeout(reorderTimer.current);
        reorderTimer.current = setTimeout(() => {
          wsRef.current?.send(
            JSON.stringify({
              v: 1,
              t: "reorder_buttons",
              buttons: reordered.map((b) => ({
                id: b.id,
                position: b.position,
              })),
            }),
          );
        }, 300);
        return reordered;
      });
    },
    [currentPage],
  );

  const buttonIds = useMemo(() => buttons.map((b) => b.id), [buttons]);

  const params = new URLSearchParams(window.location.search);
  const forceDesktop =
    params.get("desktop") === "1" ||
    import.meta.env.VITE_FORCE_DESKTOP === "true";

  const desktopMode = isElectron() || forceDesktop;

  if (desktopMode) {
    return (
      <DesktopApp
        buttons={buttons}
        setButtons={setButtons}
        pages={pages}
        setPages={setPages}
        currentPage={currentPage}
        setCurrentPage={setCurrentPage}
        status={status}
        stats={stats}
        volume={volume}
        muted={muted}
        wsRef={wsRef}
        switchPage={switchPage}
        pageButtonsCacheRef={pageButtonsCacheRef}
      />
    );
  }

  if (view === "config") return <ConfigUI onBack={() => setView("deck")} />;

  const isConnected = status === "connected";

  if (!paired) {
    return (
      <PairingScreen
        onPaired={(host, port, token) => {
          setPairConfig(host, port, token);
          setPaired(true);
          setPairedHost(host); // triggers WS useEffect to re-run
        }}
      />
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100dvh",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        background: "radial-gradient(circle at top left, #1f2230, #090909 70%)",
        fontFamily: "'SF Pro Display', 'Segoe UI', sans-serif",
      }}
    >
      <style>{globalStyles}</style>

      {/* Top bar */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "6px 16px",
          gap: 8,
          background: "linear-gradient(180deg, #1c1c1f 0%, #161618 100%)",
          borderBottom: "1px solid #2a2a2e",
          flexShrink: 0,
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 8,
            background: "linear-gradient(135deg, #6c63ff, #3b82f6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 14,
            fontWeight: 900,
            color: "#fff",
            letterSpacing: -1,
            boxShadow: "0 0 12px #6c63ff55",
            flexShrink: 0,
          }}
        >
          <img
            src={deck}
            width={28}
            height={28}
            style={{
              borderRadius: 8,
              flexShrink: 0,
              display: "block",
              boxShadow: "0 0 12px #6c63ff55",
            }}
            draggable={false}
          />
        </div>

        <span
          style={{
            fontWeight: 700,
            fontSize: 14,
            color: "#e0e0e0",
            letterSpacing: 0.3,
          }}
        >
          EchoDeck
        </span>

        {/* FEATURE: System stats — CPU / RAM / clock pills */}
        {stats && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              marginLeft: 2,
            }}
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

        {/* FEATURE: Volume controls — live volume pill */}
        {volume !== null && <VolumePill volume={volume} muted={muted} />}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            background: isConnected ? "#0d2e1a" : "#2e0d0d",
            border: `1px solid ${isConnected ? "#1a5c32" : "#5c1a1a"}`,
            borderRadius: 20,
            padding: "3px 10px",
            fontSize: 11,
            color: isConnected ? "#4ade80" : "#f87171",
            marginLeft: "auto",
          }}
        >
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: "50%",
              background: isConnected ? "#4ade80" : "#f87171",
              boxShadow: isConnected ? "0 0 6px #4ade80" : "0 0 6px #f87171",
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
          onMouseDown={(e) => {
            e.preventDefault();
            setView("config");
          }}
          style={{
            background: "none",
            border: "1px solid #333",
            borderRadius: 8,
            color: "#888",
            cursor: "pointer",
            padding: "5px 12px",
            fontSize: 12,
            fontWeight: 500,
          }}
        >
          ⚙ Config
        </button>
      </div>

      {/* Page tabs */}
      {pages.length > 1 && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: "4px 12px 0",
            background: "#161618",
            flexShrink: 0,
            height: 26,
            minHeight: 32,
            overflowX: "auto",
          }}
        >
          {pages.map((p) => (
            <button
              key={p.id}
              onMouseDown={(e) => {
                e.preventDefault();
                switchPage(p.id);
              }}
              style={{
                background:
                  currentPage === p.id
                    ? "linear-gradient(180deg, #2a2a35 0%, #1e1e28 100%)"
                    : "none",
                border: "none",
                borderBottom:
                  currentPage === p.id
                    ? "2px solid #6c63ff"
                    : "2px solid transparent",
                color: currentPage === p.id ? "#fff" : "#666",
                cursor: "pointer",
                padding: "6px 16px",
                fontSize: 12,
                fontWeight: 600,
                borderRadius: "6px 6px 0 0",
                whiteSpace: "nowrap",
                transition: "all 0.15s",
              }}
            >
              {p.name}
            </button>
          ))}
        </div>
      )}

      {/* FEATURE: Custom button size — 2x2 buttons use gridColumn/gridRow span 2 */}
      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={buttonIds} strategy={rectSortingStrategy}>
          <div
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: 14,
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(100px, 1fr))",
              gridAutoRows:
                "minmax(100px, calc((100cqw - 28px - 12px * 4) / 5))",
              gap: 12,
              alignContent: "start",
            }}
          >
            {buttons.length === 0 && status === "connected" && <SkeletonGrid />}
            {buttons.map((btn) => (
              <SortableButton
                key={btn.id}
                btn={btn}
                pressing={pressing === btn.id}
                onPress={pressButton}
                volume={volume}
                muted={muted}
                onVolumeHoldStart={startVolumeHold}
                onVolumeHoldStop={stopVolumeHold}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

// FEATURE: System stats — pill component
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
        fontSize: 10,
        fontVariantNumeric: "tabular-nums",
        transition: "all 0.5s ease",
      }}
    >
      {label && <span style={{ color: "#444" }}>{label}</span>}
      <span style={{ color: warn ? "#fb923c" : "#888" }}>{value}</span>
    </div>
  );
}

// FEATURE: Volume controls — volume pill with mini bar in the header
function VolumePill({ volume, muted }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 5,
        background: muted ? "#2e0d0d" : "#1a1a22",
        border: `1px solid ${muted ? "#5c1a1a" : "#2a2a35"}`,
        borderRadius: 12,
        padding: "2px 8px",
        fontSize: 10,
        transition: "all 0.3s ease",
      }}
    >
      <span style={{ color: muted ? "#f87171" : "#888" }}>
        {muted ? "🔇" : volume > 60 ? "🔊" : volume > 20 ? "🔉" : "🔈"}
      </span>
      <div
        style={{
          width: 32,
          height: 3,
          background: "#2a2a35",
          borderRadius: 2,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${muted ? 0 : volume}%`,
            background: muted ? "#f87171" : volume > 80 ? "#fb923c" : "#4ade80",
            borderRadius: 2,
            transition: "width 0.15s ease",
          }}
        />
      </div>
      <span
        style={{
          color: muted ? "#f87171" : "#888",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {muted ? "—" : `${volume}%`}
      </span>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <div
          key={i}
          style={{
            aspectRatio: "1 / 1",
            borderRadius: 22,
            background: "rgba(255,255,255,0.04)",
            border: "1px solid rgba(255,255,255,0.06)",
            animation: `pulse 1.8s ease-in-out ${i * 0.12}s infinite`,
          }}
        />
      ))}
    </>
  );
}

const SortableButton = memo(function SortableButton({
  btn,
  pressing,
  onPress,
  volume,
  muted,
  onVolumeHoldStart,
  onVolumeHoldStop,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: btn.id });

  const [ripple, setRipple] = useState(null);

  const sizeStyle =
    btn.size === "2x2" ? { gridColumn: "span 2", gridRow: "span 2" } : {};

  const isToggleOn =
    Number(btn.is_toggle) === 1 && Number(btn.toggle_state) === 1;
  const isToggle = Number(btn.is_toggle) === 1;

  const isVideo = btn.icon_data?.startsWith("data:video/");

  const isVolumeBtn = VOLUME_ACTIONS.has(btn.action_type);
  const isVolumeHoldBtn = VOLUME_HOLD_ACTIONS.has(btn.action_type);

  // FEATURE: Soundboard — show a small speaker indicator if the button has a sound
  const hasSound = !!btn.sound_file;

  const mergedTransition = [
    transition,
    "box-shadow 0.15s ease",
    "background 0.15s ease",
    "scale 0.1s ease",
    "border 0.15s ease",
  ]
    .filter(Boolean)
    .join(", ");

  const handleClick = useCallback(
    (e) => {
      if (isDragging) return;
      if (isVolumeHoldBtn) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setRipple({ x, y, id: Date.now() });
      setTimeout(() => setRipple(null), 600);
      onPress(btn.id);
    },
    [isDragging, onPress, btn.id, isVolumeHoldBtn],
  );

  const handlePointerDown = useCallback(
    (e) => {
      if (isDragging || !isVolumeHoldBtn) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = e.currentTarget.getBoundingClientRect();
      setRipple({
        x: ((e.clientX - rect.left) / rect.width) * 100,
        y: ((e.clientY - rect.top) / rect.height) * 100,
        id: Date.now(),
      });
      onVolumeHoldStart(btn.action_type === "volume_up" ? "up" : "down");
    },
    [isDragging, isVolumeHoldBtn, btn.action_type, onVolumeHoldStart],
  );

  const handlePointerUp = useCallback(() => {
    if (!isVolumeHoldBtn) return;
    setRipple(null);
    onVolumeHoldStop();
  }, [isVolumeHoldBtn, onVolumeHoldStop]);

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        ...sizeStyle,
        transform:
          [
            transform ? CSS.Transform.toString(transform) : null,
            isDragging ? "scale(1.06)" : pressing ? "scale(0.96)" : null,
          ]
            .filter(Boolean)
            .join(" ") || undefined,
        transition: mergedTransition,
        zIndex: isDragging ? 999 : "auto",
        aspectRatio: "1 / 1",
        borderRadius: 22,
        cursor: "pointer",
        position: "relative",
        overflow: "hidden",
        willChange: "transform",
        userSelect: "none",
        WebkitUserSelect: "none",
        isolation: "isolate",
        background: pressing
          ? "linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0.01))"
          : isToggleOn
            ? `linear-gradient(180deg, ${btn.color}44, ${btn.color}22)`
            : "linear-gradient(180deg, rgba(255,255,255,0.11), rgba(255,255,255,0.03))",
        backdropFilter: isDragging ? "none" : "blur(18px)",
        WebkitBackdropFilter: isDragging ? "none" : "blur(18px)",
        opacity: isDragging ? 0.85 : 1,
        border: isToggleOn
          ? `1px solid ${btn.color}88`
          : pressing
            ? "1px solid rgba(255,255,255,0.05)"
            : "1px solid rgba(255,255,255,0.09)",
        boxShadow: pressing
          ? `inset 0 2px 10px rgba(0,0,0,0.5), 0 2px 8px rgba(0,0,0,0.4)`
          : isToggleOn
            ? `inset 0 1px 1px rgba(255,255,255,0.15), 0 0 20px ${btn.color}66, 0 0 40px ${btn.color}33`
            : `inset 0 1px 1px rgba(255,255,255,0.15), inset 0 -10px 20px rgba(0,0,0,0.2), 0 10px 25px rgba(0,0,0,0.35), 0 0 20px ${btn.color}22`,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
      }}
    >
      {/* Ripple */}
      {ripple && (
        <span
          key={ripple.id}
          style={{
            position: "absolute",
            left: `${ripple.x}%`,
            top: `${ripple.y}%`,
            width: "60%",
            aspectRatio: "1",
            borderRadius: "50%",
            background: "rgba(255,255,255,0.18)",
            transform: "scale(0) translate(-50%, -50%)",
            transformOrigin: "0 0",
            animation: "ripple 0.55s ease-out forwards",
            pointerEvents: "none",
          }}
        />
      )}

      {/* FEATURE: Toggle buttons — indicator dot top-left */}
      {isToggle && (
        <div
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: isToggleOn ? btn.color : "rgba(255,255,255,0.15)",
            boxShadow: isToggleOn ? `0 0 6px ${btn.color}` : "none",
            animation: isToggleOn
              ? "toggleGlow 2s ease-in-out infinite"
              : "none",
            transition: "background 0.2s, box-shadow 0.2s",
            zIndex: 2,
          }}
        />
      )}

      {/* FEATURE: Soundboard — speaker dot bottom-left when a sound is attached */}
      {hasSound && (
        <div
          style={{
            position: "absolute",
            bottom: 7,
            left: 8,
            fontSize: 9,
            lineHeight: 1,
            opacity: 0.55,
            pointerEvents: "none",
            zIndex: 2,
            userSelect: "none",
          }}
        >
          🔊
        </div>
      )}

      {/* Drag handle */}
      <div
        {...listeners}
        className="drag-handle"
        style={{
          position: "absolute",
          top: 7,
          right: 7,
          width: 18,
          height: 18,
          zIndex: 10,
          cursor: "grab",
          borderRadius: 6,
          background: isDragging
            ? "rgba(255,255,255,0.14)"
            : "rgba(255,255,255,0.04)",
          border: "1px solid rgba(255,255,255,0.07)",
          opacity: isDragging ? 1 : 0,
          transition: "opacity 0.2s ease",
        }}
      />

      {/* Icon */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          borderRadius: 22,
          overflow: "hidden",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          filter: pressing ? "brightness(0.75)" : "brightness(1)",
          transition: "filter 0.08s",
        }}
      >
        {isVideo ? (
          <video
            src={btn.icon_data}
            autoPlay
            loop
            muted
            playsInline
            style={{
              width: "78%",
              height: "78%",
              objectFit: "contain",
              borderRadius: 16,
            }}
          />
        ) : btn.icon_data ? (
          <img
            src={btn.icon_data}
            style={{
              width: "78%",
              height: "78%",
              objectFit: "contain",
              borderRadius: 16,
            }}
            draggable={false}
          />
        ) : (
          <span
            style={{
              fontSize:
                btn.size === "2x2" ? "min(64px, 14vw)" : "min(48px, 11vw)",
            }}
          >
            {btn.icon}
          </span>
        )}
      </div>

      {/* FEATURE: Volume controls — live fill bar + % overlay */}
      {isVolumeBtn && volume !== null && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            pointerEvents: "none",
            zIndex: 3,
            borderRadius: 22,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "100%",
              height: `${muted ? 0 : volume}%`,
              background: muted
                ? "rgba(248,113,113,0.25)"
                : volume > 80
                  ? "rgba(251,146,60,0.2)"
                  : "rgba(74,222,128,0.15)",
              transition: "height 0.12s ease",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 8,
              left: 0,
              right: 0,
              textAlign: "center",
              fontSize: 11,
              fontWeight: 700,
              color: muted ? "#f87171" : "#fff",
              letterSpacing: 0.5,
              textShadow: "0 1px 4px rgba(0,0,0,0.8)",
            }}
          >
            {muted ? "MUTE" : `${volume}%`}
          </div>
        </div>
      )}

      <style>{`div:hover > .drag-handle { opacity: 0.35 !important; } div:active > .drag-handle { opacity: 0 !important; }`}</style>
    </div>
  );
});

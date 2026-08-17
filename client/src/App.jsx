import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import ReconnectingWebSocket from "reconnecting-websocket";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import { useSortable } from "@dnd-kit/sortable";
import deck from "/deck-icon.png";
import disconnect from "/disconnect.svg";
import DesktopApp from "./desktop/DesktopApp.jsx";
import { CSS } from "@dnd-kit/utilities";
import {
  isPaired,
  setPairConfig,
  loadPairConfig,
  getWsUrl,
  isElectron,
  clearPairConfig,
} from "./constants.js";
import PairingScreen from "./PairingScreen.jsx";
import { Icon } from "./icons.jsx";
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";

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

// FEATURE: Volume controls — the step size the user picked in the desktop
// editor lives in action_value. Range mirrors actionRegistry.js.
const VOLUME_STEP_MIN = 1;
const VOLUME_STEP_MAX = 20;
const VOLUME_STEP_DEFAULT = 5;

function volumeStepFor(btn) {
  const parsed = parseInt(btn.action_value, 10);
  if (!Number.isFinite(parsed)) return VOLUME_STEP_DEFAULT;
  return Math.min(VOLUME_STEP_MAX, Math.max(VOLUME_STEP_MIN, parsed));
}

// FEATURE: Hold to confirm — how long a guarded button must be held before it fires.
// Long enough that a stray brush can't complete it, short enough not to feel stuck.
const HOLD_CONFIRM_MS = 700;

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

// FEATURE: Soundboard — a second context so one sound can reach two devices at
// once (a virtual cable for the call, plus your headset so you hear it too).
// A context can only target one sink, hence the second one. It is created at
// the main context's sample rate so a buffer decoded once plays on both.
let _monitorCtx = null;
function getMonitorContext() {
  if (!_monitorCtx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    try {
      _monitorCtx = new Ctor({ sampleRate: getAudioContext().sampleRate });
    } catch {
      _monitorCtx = new Ctor();
    }
  }
  return _monitorCtx;
}

// FEATURE: Soundboard — decoding a base64 data URL costs a fetch plus a full
// PCM decode, which is wasteful for a soundboard pressed over and over. Keep
// the decoded buffers around, keyed by button id plus payload length so
// replacing a button's sound invalidates its entry.
const MAX_CACHED_BUFFERS = 16;
const decodedBuffers = new Map();

function cacheBuffer(key, buffer) {
  if (decodedBuffers.size >= MAX_CACHED_BUFFERS) {
    // Map preserves insertion order, so the first key is the oldest.
    decodedBuffers.delete(decodedBuffers.keys().next().value);
  }
  decodedBuffers.set(key, buffer);
}

// FEATURE: Soundboard — resolving a device label to a Chromium deviceId means
// enumerating devices, so cache it and drop the cache when devices change.
const sinkIdByLabel = new Map();
// Which sink each context is currently pointed at, so repeat presses skip the
// setSinkId round-trip. Keyed by context; there are only ever two.
const appliedSinks = new Map();

if (typeof navigator !== "undefined" && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener("devicechange", () => {
    sinkIdByLabel.clear();
    appliedSinks.clear();
  });
}

async function resolveSinkId(label) {
  if (!label) return null;
  if (sinkIdByLabel.has(label)) return sinkIdByLabel.get(label);
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const match = devices.find(
      (d) => d.kind === "audiooutput" && d.label === label,
    );
    const id = match?.deviceId ?? null;
    sinkIdByLabel.set(label, id);
    return id;
  } catch {
    return null;
  }
}

// Routes the shared context at a specific output device. Failing to route is
// never fatal — playing on the default device beats playing nothing.
async function applySink(ctx, label) {
  if (!label || typeof ctx.setSinkId !== "function") return;
  const sinkId = await resolveSinkId(label);
  if (!sinkId || appliedSinks.get(ctx) === sinkId) return;
  try {
    await ctx.setSinkId(sinkId);
    appliedSinks.set(ctx, sinkId);
  } catch (e) {
    console.warn("Could not route sound to", label, "—", e.message);
  }
}

function playBuffer(ctx, buffer) {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
}

// FEATURE: Soundboard — mirror a sound onto the monitor device. Never allowed
// to disturb the primary output, so failures here are logged and swallowed.
async function playOnMonitor(buffer, label) {
  try {
    const ctx = getMonitorContext();
    if (ctx.state === "suspended") await ctx.resume();
    await applySink(ctx, label);
    playBuffer(ctx, buffer);
  } catch (e) {
    console.warn("Monitor playback failed:", e.message);
  }
}

async function playSound(dataUrl, { id, device, monitor } = {}) {
  if (!dataUrl) return;
  try {
    const ctx = getAudioContext();
    // Resume in case the context was suspended (required on iOS)
    if (ctx.state === "suspended") await ctx.resume();

    await applySink(ctx, device);

    const cacheKey = id ? `${id}:${dataUrl.length}` : null;
    let audioBuffer = cacheKey ? decodedBuffers.get(cacheKey) : null;

    if (!audioBuffer) {
      // Fetch the base64 data URL as an ArrayBuffer and decode it
      const response = await fetch(dataUrl);
      const arrayBuffer = await response.arrayBuffer();
      audioBuffer = await ctx.decodeAudioData(arrayBuffer);
      if (cacheKey) cacheBuffer(cacheKey, audioBuffer);
    }

    playBuffer(ctx, audioBuffer);

    // Mirror to the monitor device, unless it is the one already playing.
    if (monitor && monitor !== device) playOnMonitor(audioBuffer, monitor);
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

function unlockAudio() {
  try {
    const ctx = getAudioContext();
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
  } catch (error) {
    console.warn("Could not unlock audio:", error);
  }
}

export default function App() {
  const [paired, setPaired] = useState(() => isPaired());
  const [buttons, setButtons] = useState([]);
  const [pages, setPages] = useState([]);
  const [currentPage, setCurrentPage] = useState(null);
  const [status, setStatus] = useState("connecting");
  const [pressing, setPressing] = useState(null);
  // FEATURE: System stats
  const [stats, setStats] = useState(null);
  // FEATURE: Volume controls — live volume + mute state
  const [volume, setVolume] = useState(null);
  const [muted, setMuted] = useState(false);

  const [disconnectActive, setDisconnectActive] = useState(false);
  const [keySize, setKeySize] = useState(84);
  const deckRef = useRef(null);
  const swipeRef = useRef(null);

  const wsRef = useRef(null);
  const lastMessageAtRef = useRef(0);
  const pageButtonsCacheRef = useRef(new Map());
  const reorderTimer = useRef(null);
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [pairedHost, setPairedHost] = useState(() => {
    loadPairConfig();
    return getWsUrl(); // non-null if already paired
  });

  // Forget this host and fall back to the pairing screen. Used both when the
  // user disconnects deliberately and when the host rejects our credential.
  // Clearing pairedHost tears down the socket via the effect's cleanup, which
  // is what stops a rejected client from reconnecting forever.
  const setUnpaired = useCallback(() => {
    clearPairConfig();
    setPaired(false);
    setPairedHost(null);
    setStatus("connecting");
    setButtons([]);
    setPages([]);
    setCurrentPage(null);
    setStats(null);
    setVolume(null);
    setMuted(false);
  }, []);

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
      lastMessageAtRef.current = Date.now(); // reset staleness clock — a fresh open is not "silence"
      setStatus("connected");
    };
    const onClose = (e) => {
      console.log("WS close", e.code, e.reason);
      setStatus("disconnected");
      // 1008 means the host refused our credential — revoked from the Devices
      // panel, or paired against an EchoDeck install that no longer knows us.
      // Retrying cannot fix that, so drop the pairing and ask for a new QR
      // instead of looping on a token the host will never accept.
      if (e.code === 1008) {
        console.warn("Pairing rejected by host — returning to pairing screen");
        setUnpaired();
      }
    };
    const onError = (e) => {
      console.log("WS error", e);
      setStatus("disconnected");
    };
    const onMessage = (e) => {
      lastMessageAtRef.current = Date.now();
      // Parse once and guard it: `state` payloads carry base64 icon data, and
      // a malformed frame used to throw straight out of the listener.
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        console.warn("[WS] dropped unparseable frame");
        return;
      }
      console.log("[WS] message received:", msg.t, "at", Date.now());
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
        playSound(msg.sound_file, {
          id: msg.id,
          device: msg.device,
          monitor: msg.monitor,
        });
      }
    };

    ws.addEventListener("open", onOpen);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
    ws.addEventListener("message", onMessage);
    wsRef.current = ws;

    // Tracks whether a reconnect is already underway so the interval/focus/
    // visibility/pageshow handlers can't pile on top of each other and tear
    // down a socket that's still in the middle of opening.
    let reconnectInFlightUntil = 0;

    const reconnectIfStale = () => {
      if (document.visibilityState === "hidden") return;

      const now = Date.now();
      if (now < reconnectInFlightUntil) {
        console.log("[reconnectIfStale] SKIPPED — reconnect already in flight");
        return;
      }

      const isClosedOrClosing =
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED;

      const quietFor = now - lastMessageAtRef.current;
      const isSilentWhileOpen =
        ws.readyState === WebSocket.OPEN && quietFor > 8000;

      console.log(
        "[reconnectIfStale] called, readyState:",
        ws.readyState,
        "quietFor:",
        quietFor,
        "isClosedOrClosing:",
        isClosedOrClosing,
        "isSilentWhileOpen:",
        isSilentWhileOpen,
      );

      if (isClosedOrClosing || isSilentWhileOpen) {
        console.log("[reconnectIfStale] TRIGGERING RECONNECT");
        setStatus("connecting");
        reconnectInFlightUntil = now + 5000;
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
  }, [pairedHost, setUnpaired]);

  // A deck key is square. Size it from whichever axis runs out first rather
  // than letting 1fr rows stretch it into a tall rectangle.
  const layout = useMemo(() => {
    const count = Math.max(buttons.length, 1);
    // Prefer the widest row that keeps keys reasonably large in landscape.
    const cols = Math.min(count, count <= 8 ? 4 : count <= 15 ? 5 : 7);
    return { cols, rows: Math.ceil(count / cols) };
  }, [buttons.length]);

  useEffect(() => {
    const el = deckRef.current;
    if (!el) return;
    const measure = () => {
      const gap = 8;
      // Measure the content box: getBoundingClientRect includes the padding,
      // which made keys a few pixels too big and pushed the last row under the
      // container's clip.
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const box = el.getBoundingClientRect();
      const w = (box.width - padX - (layout.cols - 1) * gap) / layout.cols;
      const h = (box.height - padY - (layout.rows - 1) * gap) / layout.rows;
      const next = Math.max(44, Math.floor(Math.min(w, h)));
      setKeySize((prev) => (Math.abs(prev - next) > 1 ? next : prev));
    };
    measure();
    // ResizeObserver alone proved unreliable here — rotating the phone changes
    // the viewport without the observed box reporting it in time — so the
    // window events back it up. Both paths call the same measure.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    window.addEventListener("orientationchange", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
      window.removeEventListener("orientationchange", measure);
    };
  }, [layout]);

  const pressButton = useCallback(async (id) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setStatus("connecting");
      wsRef.current?.reconnect?.(4000, "button press");
      return;
    }
    // Must happen synchronously inside the tap handler. Waiting for the server
    // response first loses the browser's user-gesture permission on mobile.
    unlockAudio();
    try {
      await Haptics.impact({ style: ImpactStyle.Heavy });
    } catch {
      navigator.vibrate?.(10);
    }
    setPressing(id);
    wsRef.current.send(JSON.stringify({ v: 1, t: "press", id }));
    setTimeout(() => setPressing(null), 150);
  }, []);

  // FEATURE: Hold to confirm — finger went down on a guarded button.
  // The press itself fires from a timer, which is NOT a user gesture, so the
  // audio unlock has to happen here or mobile revokes playback permission
  // for any sound attached to the button.
  const beginConfirmHold = useCallback(async () => {
    unlockAudio();
    try {
      await Haptics.impact({ style: ImpactStyle.Light });
    } catch {
      navigator.vibrate?.(5);
    }
  }, []);

  // FEATURE: Volume controls — send hold_start when finger goes down on a vol button
  const startVolumeHold = useCallback((direction, step) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setStatus("connecting");
      wsRef.current?.reconnect?.(4000, "volume hold");
      return;
    }
    wsRef.current.send(
      JSON.stringify({ t: "volume_hold_start", direction, step }),
    );
  }, []);

  // FEATURE: Volume controls — send hold_stop when finger lifts
  const stopVolumeHold = useCallback(() => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ t: "volume_hold_stop" }));
  }, []);

  const handleDisconnect = useCallback(() => {
    setShowDisconnectConfirm(true);
  }, []);

  const confirmDisconnect = useCallback(() => {
    setShowDisconnectConfirm(false);
    wsRef.current?.close();
    wsRef.current = null;
    setUnpaired();
  }, [setUnpaired]);

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

  // Horizontal swipe changes page. A key press is a tap, so only a deliberate
  // horizontal travel counts — vertical movement is left alone so the deck
  // never fights a scroll, and short movements stay taps.
  const onDeckPointerDown = useCallback((e) => {
    swipeRef.current = { x: e.clientX, y: e.clientY };
  }, []);

  const onDeckPointerUp = useCallback(
    (e) => {
      const startPt = swipeRef.current;
      swipeRef.current = null;
      if (!startPt || pages.length < 2) return;
      const dx = e.clientX - startPt.x;
      const dy = e.clientY - startPt.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

      const i = pages.findIndex((p) => p.id === currentPage);
      if (i === -1) return;
      const next = pages[(i + (dx < 0 ? 1 : -1) + pages.length) % pages.length];
      if (next) switchPage(next.id);
    },
    [pages, currentPage, switchPage],
  );


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
        height: "100%",
        paddingTop: "env(safe-area-inset-top)",
        // paddingBottom: "env(safe-area-inset-bottom)",
        // paddingLeft: "env(safe-area-inset-left)",
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
          paddingLeft: "max(env(safe-area-inset-left), 16px)",
          paddingRight: "max(env(safe-area-inset-right), 16px)",
          paddingTop: 0,
          paddingBottom: 0,
          gap: 6,
          height: 44,
          flexShrink: 0,
          background: "linear-gradient(180deg, #1c1c1f 0%, #161618 100%)",
          borderBottom: "1px solid #2a2a2e",
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
            width={24}
            height={24}
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
            height: 24,
            boxSizing: "border-box",
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
      </div>

      {/* FEATURE: Custom button size — 2x2 buttons use gridColumn/gridRow span 2 */}
      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={buttonIds} strategy={rectSortingStrategy}>
          {/* Container */}
          <div
            ref={deckRef}
            onPointerDown={onDeckPointerDown}
            onPointerUp={onDeckPointerUp}
            style={{
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
              paddingLeft: "max(env(safe-area-inset-left), 10px)",
              paddingRight: "max(env(safe-area-inset-right), 10px)",
              paddingTop: 4,
              paddingBottom: 4,
              display: "grid",
              placeContent: "center",
              gridTemplateColumns: `repeat(${layout.cols}, ${keySize}px)`,
              gridAutoRows: `${keySize}px`,
              gap: 8,
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
                onConfirmHoldStart={beginConfirmHold}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>

      {/* FEATURE: Deck layout — swipe changes page; the dots do the same by tap,
          so the deck is never gesture-only. */}
      {pages.length > 1 && (
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: 7,
            padding: "2px 0 8px",
            flexShrink: 0,
          }}
        >
          {pages.map((p) => {
            const active = p.id === currentPage;
            return (
              <button
                key={p.id}
                onClick={() => switchPage(p.id)}
                aria-label={p.name}
                aria-current={active}
                style={{
                  // Fixed footprint: the pill inside scales, so growing the
                  // active dot never reflows the row. Animating width here
                  // would thrash layout on every page change.
                  width: 18,
                  height: 7,
                  padding: 0,
                  border: 0,
                  background: "transparent",
                  cursor: "pointer",
                  display: "grid",
                  placeItems: "center",
                }}
              >
                <span
                  style={{
                    width: 18,
                    height: 7,
                    borderRadius: 999,
                    background: active ? "#3b82f6" : "#303039",
                    transform: `scaleX(${active ? 1 : 7 / 18})`,
                    transition:
                      "transform 0.16s ease, background 0.16s ease",
                  }}
                />
              </button>
            );
          })}
        </div>
      )}

      {showDisconnectConfirm && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            padding: "0 32px",
          }}
        >
          <div
            style={{
              background: "#16161e",
              border: "1px solid #2a2a38",
              borderRadius: 18,
              padding: "28px 24px",
              width: "100%",
              maxWidth: 320,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 32, marginBottom: 12 }}>⏏️</div>
            <div
              style={{
                fontWeight: 700,
                fontSize: 16,
                color: "#e0e0ec",
                marginBottom: 8,
              }}
            >
              Disconnect?
            </div>
            <div
              style={{
                fontSize: 13,
                color: "#55556a",
                marginBottom: 24,
                lineHeight: 1.5,
              }}
            >
              You'll need to scan the QR code again to reconnect.
            </div>
            <div style={{ display: "flex", gap: 10 }}>
              <button
                onClick={() => setShowDisconnectConfirm(false)}
                style={{
                  flex: 1,
                  padding: "12px 0",
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10,
                  color: "#888",
                  fontSize: 14,
                  cursor: "pointer",
                  fontWeight: 600,
                }}
              >
                Cancel
              </button>
              <button
                onClick={confirmDisconnect}
                style={{
                  flex: 1,
                  padding: "12px 0",
                  background: "#2e0d0d",
                  border: "1px solid #5c1a1a",
                  borderRadius: 10,
                  color: "#f87171",
                  fontSize: 14,
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                Disconnect
              </button>
            </div>
          </div>
        </div>
      )}
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
        <Icon name="sound" size={13} />
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
            width: "100%",
            transformOrigin: "left center",
            transform: `scaleX(${(muted ? 0 : volume) / 100})`,
            // Level is a quantity, not a health status — neutral white, with red
              // kept for muted, which is a state worth flagging.
              background: muted ? "#f87171" : "rgba(255,255,255,0.85)",
            borderRadius: 2,
            transition: "transform 0.15s ease",
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
  onConfirmHoldStart,
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
  // FEATURE: Hold to confirm — local to the tile; nothing above needs to know.
  const [holding, setHolding] = useState(false);
  const holdTimerRef = useRef(null);

  const sizeStyle =
    btn.size === "2x2" ? { gridColumn: "span 2", gridRow: "span 2" } : {};

  const isToggleOn =
    Number(btn.is_toggle) === 1 && Number(btn.toggle_state) === 1;
  const isToggle = Number(btn.is_toggle) === 1;

  const isVideo = btn.icon_data?.startsWith("data:video/");

  const isVolumeBtn = VOLUME_ACTIONS.has(btn.action_type);
  const isVolumeHoldBtn = VOLUME_HOLD_ACTIONS.has(btn.action_type);
  const volumeStep = volumeStepFor(btn);

  // FEATURE: Hold to confirm — volume buttons own the pointer-hold gesture
  // already, so the two are mutually exclusive by construction.
  const requiresConfirm =
    Number(btn.require_confirm) === 1 && !isVolumeHoldBtn;

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

  // FEATURE: Hold to confirm — abandoning the hold leaves no state behind,
  // so there is never an "armed" button waiting to fire on a later tap.
  const cancelHold = useCallback(() => {
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
    setHolding(false);
  }, []);

  useEffect(() => () => clearTimeout(holdTimerRef.current), []);

  const handleClick = useCallback(
    (e) => {
      if (isDragging) return;
      if (isVolumeHoldBtn) return;
      // Guarded buttons fire from the hold timer, never from a tap.
      if (requiresConfirm) return;
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      setRipple({ x, y, id: Date.now() });
      setTimeout(() => setRipple(null), 600);
      onPress(btn.id);
    },
    [isDragging, onPress, btn.id, isVolumeHoldBtn, requiresConfirm],
  );

  const handlePointerDown = useCallback(
    (e) => {
      if (isDragging) return;
      if (!isVolumeHoldBtn && !requiresConfirm) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      const rect = e.currentTarget.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;

      if (requiresConfirm) {
        setHolding(true);
        onConfirmHoldStart();
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          setHolding(false);
          setRipple({ x, y, id: Date.now() });
          setTimeout(() => setRipple(null), 600);
          onPress(btn.id);
        }, HOLD_CONFIRM_MS);
        return;
      }

      setRipple({ x, y, id: Date.now() });
      onVolumeHoldStart(
        btn.action_type === "volume_up" ? "up" : "down",
        volumeStep,
      );
    },
    [
      isDragging,
      isVolumeHoldBtn,
      requiresConfirm,
      volumeStep,
      btn.id,
      btn.action_type,
      onPress,
      onConfirmHoldStart,
      onVolumeHoldStart,
    ],
  );

  const handlePointerUp = useCallback(() => {
    if (requiresConfirm) {
      cancelHold();
      return;
    }
    if (!isVolumeHoldBtn) return;
    setRipple(null);
    onVolumeHoldStop();
  }, [requiresConfirm, cancelHold, isVolumeHoldBtn, onVolumeHoldStop]);

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
        width: "100%",
        height: "100%",
        borderRadius: 18,
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
          <Icon name="sound" size={9} />
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
            left: 10,
            right: 10,
            bottom: 8,
            pointerEvents: "none",
            zIndex: 3,
            display: "flex",
            flexDirection: "column",
            gap: 4,
            alignItems: "center",
          }}
        >
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.4,
              color: muted ? "#f87171" : "rgba(255,255,255,0.82)",
              textShadow: "0 1px 3px rgba(0,0,0,0.7)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {muted ? "MUTED" : `${volume}%`}
          </span>
          <span
            style={{
              width: "100%",
              height: 3,
              borderRadius: 2,
              background: "rgba(255,255,255,0.14)",
              overflow: "hidden",
            }}
          >
            <span
              style={{
                display: "block",
                width: "100%",
                height: "100%",
                borderRadius: 2,
                transformOrigin: "left center",
                transform: `scaleX(${(muted ? 0 : volume) / 100})`,
                background: muted ? "#f87171" : "rgba(255,255,255,0.92)",
                transition: "transform 0.12s ease, background 0.12s ease",
              }}
            />
          </span>
        </div>
      )}

      {/* FEATURE: Hold to confirm — caution tint plus a progress ring that
          tracks the tile edge, so it stays readable around the fingertip
          covering the middle of the button. */}
      {requiresConfirm && (
        <>
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: "rgba(251,191,36,0.16)",
              opacity: holding ? 1 : 0,
              transition: "opacity 0.12s ease",
              pointerEvents: "none",
              zIndex: 4,
            }}
          />
          <svg
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              opacity: holding ? 1 : 0,
              transition: "opacity 0.12s ease",
              pointerEvents: "none",
              zIndex: 5,
            }}
          >
            <rect
              x="1"
              y="1"
              width="98"
              height="98"
              rx="7"
              ry="7"
              fill="none"
              stroke="#fbbf24"
              strokeWidth="2.5"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              pathLength="100"
              strokeDasharray="100"
              strokeDashoffset={holding ? 0 : 100}
              style={{
                transition: holding
                  ? `stroke-dashoffset ${HOLD_CONFIRM_MS}ms linear`
                  : "stroke-dashoffset 0.15s ease",
              }}
            />
          </svg>
          {/* Resting hint — tells you the button is guarded before you touch it */}
          <div
            style={{
              position: "absolute",
              bottom: 7,
              right: 8,
              fontSize: 9,
              lineHeight: 1,
              opacity: holding ? 0 : 0.5,
              transition: "opacity 0.12s ease",
              pointerEvents: "none",
              zIndex: 6,
              userSelect: "none",
            }}
          >
            <Icon name="guarded" size={9} />
          </div>
        </>
      )}

      <style>{`div:hover > .drag-handle { opacity: 0.35 !important; } div:active > .drag-handle { opacity: 0 !important; }`}</style>
    </div>
  );
});

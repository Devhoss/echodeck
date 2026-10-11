import { useCallback, useEffect, useMemo, useRef, useState, memo } from "react";
import ReconnectingWebSocket from "reconnecting-websocket";
import { Haptics, ImpactStyle } from "@capacitor/haptics";
import DesktopApp from "./desktop/DesktopApp.jsx";
import {
  isPaired,
  setPairConfig,
  loadPairConfig,
  getWsUrl,
  isElectron,
  clearPairConfig,
  authFetch,
  jsonArray,
} from "./constants.js";
import PairingScreen from "./PairingScreen.jsx";
import { ButtonFace, Icon } from "./icons.jsx";
import { useDeckLayout } from "./layout/useDeckLayout.js";
import { mergeLayout } from "./layout/layoutSettings.js";
// FEATURE: Page reordering — `visibleDeckPages` keeps the hidden Unfiled bucket out
// of deck navigation; `pagesInOrder` repaints the pager in the draft's order.
import { pagesInOrder, visibleDeckPages } from "./layout/deckPages.js";
// FEATURE: Edit Layout (Phase 4, Tasks 4.3a + 4.3b) — the pure draft model. 4.3a
// used createDraft/reorder/diffDraft; 4.3b adds the per-item mutations
// (resize/moveToPage/detach) for the toolbar and its full Save commit.
import {
  createDraft,
  reorder,
  diffDraft,
  resize,
  moveToPage,
  detach,
  shiftPage,
} from "./layout/layoutDraft.js";
import DeckEditorBar from "./mobile/DeckEditorBar.jsx";
// FEATURE: Mobile customization (Tasks 5.1 + 5.2) — the collapsed status
// handle replaces the old always-on header bar, and the push-down control
// sheet it opens holds everything the header used to pin on screen.
import StatusHandle from "./mobile/StatusHandle.jsx";
import ControlSheet from "./mobile/ControlSheet.jsx";
// FEATURE: Mobile customization (Task 5.3) — pure geometry of the pull-down
// gesture (origin strip test + vertical-dominance test), unit-tested in
// client/test/pullDownGesture.test.js.
import {
  isPullDownGesture,
  originInPullZone,
} from "./mobile/pullDownGesture.js";
// FEATURE: Edit Layout — the same dnd-kit surface the desktop editor already
// uses (see desktop/DesktopApp.jsx). Only the reorder plumbing is wired here.
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  rectIntersection,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { WidgetTile } from "./widgets/WidgetTile.jsx";
import { SystemMonitorWidget } from "./widgets/SystemMonitorWidget.jsx";
// Playwright viewport harness (Task 7.1) — `?mock=1` swaps the phone socket
// for a pure in-memory stand-in fed the canned fixture frames. Flag-guarded at
// every call site, so the production bundle behaves byte-identically without
// the query param.
import { isMockMode } from "./mock/mockMode.js";
import { createMockSocket } from "./mock/mockSocket.js";
import {
  HOLD_REPEAT_ACTIONS,
  levelTargetFor,
  unpackAppValue,
} from "./actionRegistry.js";

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

// FEATURE: Volume controls — speaker and microphone keys behave identically,
// so which ids show a level and which repeat while held now lives in the action
// registry rather than being duplicated per surface.

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

// FEATURE: Edit Layout (Task 4.3a) — the long-press door into edit mode. It has
// to be clearly longer than a tap but shorter than the guarded-button hold, or
// the two gestures would be indistinguishable; and it aborts on the same 10 px
// travel dnd-kit uses to activate a drag, so a deliberate swipe-to-page or a
// scroll never arms it.
const LONG_PRESS_ENTER_EDIT_MS = 500;
const LONG_PRESS_CANCEL_PX = 10;

// Tiles are keyed by a composite "kind:id" for both the draft model and dnd-kit:
// buttons and widgets have independent numeric id sequences, so a bare id is not
// unique across kinds (see the identity section of layoutDraft.js).
const tileSortKey = (it) => `${it.kind}:${it.id}`;

// A module-level empty list keeps `SortableContext`'s `items` prop reference
// stable outside edit mode, instead of a fresh `[]` on every render.
const EMPTY_SORTABLE_IDS = [];

// The dnd-kit / draft id for a tile. Rows that came out of `createDraft` carry a
// normalized `key`; a page the draft does not own yet is still rendered from the
// host's rows, which do not — so the key is derived the same way either way.
const sortKeyOf = (it) => it.key ?? tileSortKey(it);

// Does the draft own this page yet? A page the user has not edited is still
// represented by the host's rows rather than by a copy parked in the draft, so a
// multi-page deck can be edited page-by-page (acceptance: "page switching
// preserves the draft across pages") without an effect copying state into state.
// Once a page HAS been edited its draft rows win and the host's order is ignored
// — which is exactly what makes the draft survive a page flip. Both helpers are
// pure and take everything as arguments, so they live at module scope.
const draftHasPage = (draft, pageId) =>
  !!draft && draft.items.some((it) => it.page_id === pageId);

const rowsForPage = (draft, pageId, serverRows) =>
  draft && draftHasPage(draft, pageId)
    ? draft.items
        .filter((it) => it.page_id === pageId)
        .sort((a, b) => a.slot - b.slot)
    : serverRows;

// FEATURE: Edit Layout (Task 4.3b) — the provisional Unfiled page id. A detach
// stores THIS on the tile's page_id (and on draft.unfiledPageId) so entering edit
// mode and detaching before Save performs ZERO host writes; the real hidden
// "Unfiled" page is materialized only in handleSave, which maps this constant to
// the created/reused page id at that moment. Must stay stable across renders.
const UNFILED_TARGET = "__unfiled__";

// dnd-kit / preview arrayMove: remove `from`, insert at `to`. Kept local (the
// dnd-kit one is for its own sortable list; this is for previewOrder arrays of
// composite keys) so the drop preview and the engine feed share one semantic.
const arrayMoveKeys = (list, from, to) => {
  const out = list.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
};

// FEATURE: Edit Layout (Task 4.3b) — fold the currently-viewed page into the
// draft before any toolbar mutation, mirroring handleDragEnd's fold. A page the
// draft does not own yet is still host rows, so `resize`/`moveToPage`/`detach`
// would find the tile absent from `draft.byId` and no-op on the first action for
// every page after the first. `createDraft` re-densifies per page, so an
// already-edited page keeps the order the user made. Pure, module-scope.
// FEATURE: Page reordering — `draft.pageOrder` MUST be carried through this
// rebuild: createDraft defaults it to [], so folding a page mid-session would
// silently RESET a page move the user already made, exactly like the item rows
// would reset if their slots were dropped.
const foldPageIntoDraft = (draft, pageId, serverRows) =>
  draftHasPage(draft, pageId)
    ? draft
    : createDraft([...draft.items, ...serverRows], draft.pageOrder);

// FEATURE: Edit Layout (Task 4.3a review) — reconcile ONE page's rows against
// the host's authoritative snapshot. A `state` frame carries per-item rows for
// exactly one page (`current_page`), and the only way a page gets into the draft
// is by being *viewed* (folding in `handleDragEnd`, or seeded at entry), which is
// also when its fresh `state` frame lands. So reconciling the frame's own page is
// the correct scope — a page the draft does not own is already rendered from
// server rows and needs nothing.
//
// The rule is membership-based, not order-based. `rowsForPage` permanently
// prefers a folded page's draft rows, so if the server's membership for that page
// ever diverges from what the client last saw, `diffDraft` keeps emitting a stale
// `{kind,id,slot}` batch for it, the host's all-or-nothing `applyItemReorder`
// rejects every such batch (silently — no reply frame), and every future Save for
// that page is rejected forever while the client reports success. Re-seeding that
// page from server truth on divergence breaks the cycle: the next diff is
// computed against the real membership.
//
// A pure reorder (same tiles, different order — the whole point of editing) keeps
// membership identical, so it is NEVER flagged as divergence and an unsaved
// reorder is never clobbered by an unrelated broadcast. `createDraft` re-densifies
// per page and leaves the other pages' rows and hand-made order untouched.
const draftPageDiverges = (draft, pageId, serverItems) => {
  if (!draft || !draftHasPage(draft, pageId)) return false;
  const serverSet = new Set(serverItems.map((it) => tileSortKey(it)));
  const draftRows = draft.items.filter((it) => it.page_id === pageId);
  // Divergence = membership differs (count, or any id present/absent). Order is
  // intentionally ignored: a reorder is work to keep, not a mismatch.
  return (
    draftRows.length !== serverSet.size ||
    draftRows.some((it) => !serverSet.has(tileSortKey(it)))
  );
};

// Replace `pageId`'s rows with the server snapshot while keeping every other page
// intact. Returns the input reference when the draft is null (inert outside edit
// mode). It is applied to whatever draft/baseline the caller is updating, and the
// caller only reaches it once `draftPageDiverges` has confirmed that model's own
// membership for the page disagrees with the server — so after a Save (baseline ==
// draft) a divergent page re-seeds in BOTH and the two converge to identical
// server rows, and no stale (or spurious) batch is emitted for it again.
// FEATURE: Page reordering — the rebuild keeps THIS model's own `pageOrder`. It is
// applied to the draft and to the baseline separately, so an unsaved page move
// survives the re-seed on the draft while the baseline keeps the order the host
// still has — exactly the diff Save must emit. Dropping the order here would reset
// both to [] and silently swallow the pending move.
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

if (
  typeof navigator !== "undefined" &&
  navigator.mediaDevices?.addEventListener
) {
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
  // FEATURE: Edit Layout (Phase 4) — draft-mode gate. While true a tile keeps
  // only its drag/select behavior; press, hold-confirm and volume-hold are
  // suppressed below (Task 4.2 model: layoutDraft.js). Task 4.3 owns the entry
  // door and the EditorBar, so nothing here lets a user flip this yet — the
  // setter is handed off through editModeApiRef for that future control.
  const [editMode, setEditMode] = useState(false);
  // FEATURE: Edit Layout (Task 4.3a) — the in-memory draft. `draft` is the live
  // working model (null outside edit mode); `baseDraft` is the snapshot it was
  // seeded from, which is what `diffDraft` compares against and what Discard
  // reverts to. Both are treated as immutable (every layoutDraft op returns a
  // new object), so seeding them from the same reference is intentional.
  const [draft, setDraft] = useState(null);
  const [baseDraft, setBaseDraft] = useState(null);
  // The tile the editor bar's (Task 4.3b) toolbar will act on, plus the tile
  // currently under the finger for the DragOverlay ghost, plus a transient
  // inline Save failure. All three only mean anything while `editMode` is on.
  const [selectedTileId, setSelectedTileId] = useState(null);
  const [activeDragId, setActiveDragId] = useState(null);
  const [editToast, setEditToast] = useState(null);
  // FEATURE: Edit Layout (Task 4.3b) — live drop preview. `previewOrder` maps a
  // page id (String) to the tentative composite-key ORDER for that page while a
  // drag is in flight; it is the ONLY thing onDragOver mutates (the draft is
  // never touched until onDragEnd), so a cancelled drag costs nothing (D8). null
  // means "no preview active" and the deck falls back to the committed order.
  const [previewOrder, setPreviewOrder] = useState(null);
  // Suppresses the host-echo draft/baseline re-seed while a Save is committing,
  // so the many `state` broadcasts fired by the move/resize sends cannot race the
  // optimistic `setBaseDraft(draft)` at the end of the batch. See handleSave.
  const saveInFlightRef = useRef(false);
  // Timestamp of the last completed/cancelled drag, so the click a drag also
  // emits cannot land a second, contradictory selection flip.
  const lastDragEndAtRef = useRef(0);
  const [status, setStatus] = useState("connecting");
  const [pressing, setPressing] = useState(null);
  // FEATURE: System stats
  const [stats, setStats] = useState(null);
  // FEATURE: Volume controls — live volume + mute state
  const [volume, setVolume] = useState(null);
  const [micVolume, setMicVolume] = useState(null);
  const [micMuted, setMicMuted] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [muted, setMuted] = useState(false);
  // FEATURE: Live widgets — tile config arrives with `state`, and the numbers
  // arrive separately as `widget_data`, so a reconnect repopulates both from
  // the last thing the host knew.
  const [widgets, setWidgets] = useState([]);
  const [widgetData, setWidgetData] = useState({});
  // The source list is what a tile prints as its host line. The phone never
  // fetched it, so every remote tile was labelled "This PC" here.
  const [widgetSources, setWidgetSources] = useState([]);
  // FEATURE: Layout settings (Task 6.1) — the deck-wide layout_config the
  // engine layers under page overrides (page > global > defaults). Read once
  // after pairing (see the effect below) — the phone only RENDERS a layout
  // configured on desktop now; detailed editing is desktop-only, so nothing
  // here writes it any more. The host's `state` frame carries per-page configs
  // but no global one.
  const [globalLayout, setGlobalLayout] = useState(null);

  const [disconnectActive, setDisconnectActive] = useState(false);
  // FEATURE: Mobile customization (Task 5.2) — the control sheet's expanded
  // state. It lives here (not in the sheet) because StatusHandle's
  // aria-expanded and the sheet's push-down slot are siblings in this column,
  // and the deck's ResizeObserver must see the sheet's box change.
  const [sheetOpen, setSheetOpen] = useState(false);
  const deckRef = useRef(null);
  const swipeRef = useRef(null);
  // FEATURE: Mobile customization (Task 5.3) — pull-down gesture state.
  // `rootRef` is the mobile outer flex column; the gesture listens in its
  // CAPTURE phase so a downward pull starting on the top strip is claimed
  // before the handle's or a tile's own pointer handlers run.
  // `pullPendingRef` holds the candidate sequence's origin (null = none);
  // `safeTopPxRef` caches the computed env(safe-area-inset-top) padding once —
  // getComputedStyle forces layout, so it must not run per pointermove.
  // `sheetOpenRef` mirrors sheetOpen for the move handler's "already open
  // claims nothing" rule without re-installing the listeners on every toggle.
  const rootRef = useRef(null);
  const pullPendingRef = useRef(null);
  // Set when a pull-down CLAIMS the sequence; consumed by the handle's toggle
  // so the click that trails the pull's pointerup does not immediately close
  // the sheet the pull just opened (pointerup precedes click by spec, so the
  // flag survives until either the trailing click consumes it or the next
  // pointerdown clears it as stale).
  const pullClaimedRef = useRef(false);
  const safeTopPxRef = useRef(null);
  const sheetOpenRef = useRef(false);
  useEffect(() => {
    sheetOpenRef.current = sheetOpen;
  }, [sheetOpen]);

  const wsRef = useRef(null);
  const lastMessageAtRef = useRef(0);
  const pageButtonsCacheRef = useRef(new Map());
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [pairedHost, setPairedHost] = useState(() => {
    loadPairConfig();
    return getWsUrl(); // non-null if already paired
  });

  // Which surface this run renders. Hoisted above the effects below because
  // the phone-only global-layout fetch has to skip the desktop surface, where
  // DesktopApp owns that state itself (and hooks must not read it after the
  // early return that lives further down).
  const params = new URLSearchParams(window.location.search);
  const forceDesktop =
    params.get("desktop") === "1" ||
    import.meta.env.VITE_FORCE_DESKTOP === "true";

  const desktopMode = isElectron() || forceDesktop;

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
    setGlobalLayout(null);
  }, []);

  useEffect(() => {
    const wsUrl = getWsUrl();
    // Task 7.1 harness: `?mock=1` runs the real production App against an
    // in-memory socket, so the deck needs neither a pairing nor a host. With
    // the flag absent this branch never runs and the effect is unchanged.
    const useMock = isMockMode();
    if (!wsUrl && !useMock) return;

    lastMessageAtRef.current = Date.now();
    const ws = useMock
      ? createMockSocket()
      : new ReconnectingWebSocket(getWsUrl(), [], {
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
      console.warn("WS error", e);
      setStatus("disconnected");
    };
    // A hold sends optimistic updates for one target only, so each field is
    // applied only when the message actually carries it — otherwise a speaker
    // hold would blank the mic reading and vice versa. Declared here rather
    // than as a component-level callback because both callers are in this
    // handler, so it needs no hook dependency.
    const applyLevels = (msg) => {
      if (msg.volume !== null && msg.volume !== undefined)
        setVolume(msg.volume);
      if (msg.muted !== null && msg.muted !== undefined) setMuted(msg.muted);
      if (msg.mic_volume !== null && msg.mic_volume !== undefined)
        setMicVolume(msg.mic_volume);
      if (msg.mic_muted !== null && msg.mic_muted !== undefined)
        setMicMuted(msg.mic_muted);
      if (Array.isArray(msg.sessions)) setSessions(msg.sessions);
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
      if (msg.t === "state") {
        setPages(msg.pages);
        setCurrentPage(msg.current_page);
        pageButtonsCacheRef.current.set(msg.current_page, msg.buttons);
        setButtons(msg.buttons);
        // FEATURE: Live widgets — tiles for the page being switched to, with the
        // last known snapshot attached, so the first paint already has numbers.
        setWidgets(Array.isArray(msg.widgets) ? msg.widgets : []);
        const next = {};
        for (const widget of msg.widgets || [])
          next[widget.id] = widget.data || {};
        setWidgetData(next);
        // FEATURE: Edit Layout (Task 4.3a review) — reconcile the draft against
        // the host's truth. Save is optimistic: it advances `baseDraft` and shows
        // an in-progress toast the moment the frame is sent, but the host answers
        // a *rejected* batch with silence (no reply, no broadcast). If this client's
        // membership for the page it is viewing has diverged from the server's,
        // every future reorder batch for that page would be rejected forever. This
        // re-seeds exactly that page from the snapshot the frame carries — the only
        // page a `state` frame describes item-by-item, and the only page the user
        // can fold/edit next, so this is the full scope of the fix.
        //
        // There is no *edit-mode* ref gate here on purpose: `draft`/`baseDraft`
        // are null *exactly* while not editing (seeded on entry, dropped on Done /
        // toggle-exit), so each updater bails on a null/owning-page-free model
        // before building anything — normal mode does zero work and both setters
        // no-op by reference, leaving that path byte-for-byte unchanged. A gate
        // that read an edit-mode ref written in another effect would also violate
        // the repo's react-hooks/immutability rule. The decision is
        // membership-based, so an unsaved reorder (same tiles, different order) is
        // never overwritten. (The 4.3b `saveInFlightRef` gate below is a different
        // thing: a ref read only in this listener and written in the handleSave
        // callback — never in an effect — so it does not trip that rule.)
        //
        // 4.3b: Save now also commits moves/detachments/size before the reorder
        // batches. Each of those sends triggers a host `state` broadcast; while a
        // Save is in flight we deliberately do NOT re-seed the draft/baseline from
        // those echoes (they are our own writes arriving out of order relative to
        // the batch), so the optimistic `setBaseDraft(draft)` at the end of
        // handleSave cannot race them. Ordinary `state` frames still reconcile
        // exactly as in 4.3a, and normal mode is inert (draft null → bails).
        if (!saveInFlightRef.current) {
          const pageId = msg.current_page;
          const reseedIfDiverged = (prev) => {
            // Cheap bail-outs first, so normal mode never allocates the snapshot.
            if (!prev || !draftHasPage(prev, pageId)) return prev;
            const serverItems = [
              ...(Array.isArray(msg.buttons) ? msg.buttons : []).map((b) => ({
                ...b,
                kind: "button",
              })),
              ...(Array.isArray(msg.widgets) ? msg.widgets : []).map((w) => ({
                ...w,
                kind: "widget",
              })),
            ];
            // After a Save the baseline owns exactly the draft's pages, so a
            // divergent page re-seeds in BOTH and the two become identical server
            // rows: the stale batch disappears, the infinite reject is broken, and
            // the user re-folds that page from real membership on the next drag.
            return draftPageDiverges(prev, pageId, serverItems)
              ? reseedPageFromServer(prev, pageId, serverItems)
              : prev;
          };
          setDraft(reseedIfDiverged);
          setBaseDraft(reseedIfDiverged);
        }
      }
      if (msg.t === "widget_data") {
        // Merge rather than replace: the frame only carries the ticks whose
        // source changed this round, and dropping the rest would blank tiles
        // whose host is simply quiet.
        setWidgetData((prev) => ({ ...prev, ...msg.data }));
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
        applyLevels(msg);
      }
      // FEATURE: Volume controls — instant volume update
      if (msg.t === "volume") {
        applyLevels(msg);
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
      if (now < reconnectInFlightUntil) return;

      const isClosedOrClosing =
        ws.readyState === WebSocket.CLOSING ||
        ws.readyState === WebSocket.CLOSED;

      const quietFor = now - lastMessageAtRef.current;
      const isSilentWhileOpen =
        ws.readyState === WebSocket.OPEN && quietFor > 8000;

      if (isClosedOrClosing || isSilentWhileOpen) {
        // Kept: an actual reconnect is rare and is the thing you want in the
        // log when a phone drops. The per-tick "still fine" line above was not.
        console.warn(
          `Reconnecting — socket ${ws.readyState}, quiet for ${quietFor}ms`,
        );
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

  // FEATURE: Live widgets — the data sources a phone's tiles are bound to. Fetched
  // here as well as on the desktop, because the tile's host line is drawn from
  // this list on every render and a phone has no editor to trigger it.
  //
  // authFetch carries the pairing token: the host rejects a token-less remote
  // request with a JSON object, and treating that as the source list used to
  // crash the render the moment a widget page appeared.
  useEffect(() => {
    let cancelled = false;
    authFetch("/widget-sources")
      .then(jsonArray)
      .then((list) => !cancelled && setWidgetSources(list))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [widgets, pairedHost]);

  // FEATURE: Layout settings (Task 6.1) — the deck-wide layout_config. The
  // host's `state` frame carries per-page layout_config (toDeckPage) but NO
  // global one — sendState has no settings field — so the phone reads it once
  // from GET /api/settings when the pairing comes up. This read-only fetch is
  // how the phone renders a layout configured on the desktop; the phone itself
  // no longer writes layout config (detailed settings are desktop-only).
  // No polling: the fetch failure just means the deck runs on defaults until
  // the next pairing. The desktop surface is skipped: DesktopApp reads
  // /settings in its own boot fetch and owns the state there.
  useEffect(() => {
    if (!paired || desktopMode) return;
    let cancelled = false;
    authFetch("/settings")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setGlobalLayout(
          d && typeof d.layout_config === "object" && d.layout_config
            ? d.layout_config
            : null,
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [paired, desktopMode]);

  // FEATURE: Key labels — a per-page preference, so read it off the page being
  // viewed rather than remembering a deck-wide value. Held as state it lagged a
  // page behind whenever a profile was switched from elsewhere (auto-switch
  // rules, or the editor's own page rail).
  const showLabels = !!pages.find((p) => p.id === currentPage)?.show_labels;

  // FEATURE: Live widgets — tiles on the page being viewed, plus the latest
  // frame received for each. The frame is only ever written here, never inside
  // the tile, so a widget that just lost its source renders the last thing it
  // was told rather than flickering back to a blank.
  const widgetsForPage = useMemo(
    () => widgets.filter((w) => w.page_id === currentPage),
    [widgets, currentPage],
  );

  // FEATURE: Responsive layout — one slot-ordered list of every tile kind, so
  // the engine interleaves buttons and widgets the way the host arranged them
  // instead of drawing all keys first. The sort is stable (ES2019), so tied
  // slots keep their merge order: buttons ahead of widgets. `position` is the
  // fallback for talking to a host that predates `slot`.
  const deckItems = useMemo(() => {
    const merged = [
      ...buttons.map((b) => ({ ...b, kind: "button" })),
      ...widgetsForPage.map((w) => ({ ...w, kind: "widget" })),
    ];
    return merged.sort(
      (a, b) => (a.slot ?? a.position) - (b.slot ?? b.position),
    );
  }, [buttons, widgetsForPage]);

  // Layout knobs (Phase 6.1): the current page's layout_config resolves over
  // the deck-wide globalLayout, which itself resolves over DEFAULT_SETTINGS —
  // the full page > global > defaults cascade. mergeLayout sanitizes both
  // scopes, so a null/absent global (fetch pending or failed) is "no opinion".
  const layoutSettings = useMemo(
    () =>
      mergeLayout(
        globalLayout,
        pages.find((p) => p.id === currentPage)?.layout_config,
      ),
    [globalLayout, pages, currentPage],
  );

  const visiblePages = useMemo(() => visibleDeckPages(pages), [pages]);

  // FEATURE: Page reordering — the pager reflects the draft's order while editing,
  // so a Move earlier / Move later tap shows up immediately on the dots. Outside
  // edit mode this is `visiblePages` unchanged (the draft is null), so normal
  // navigation keeps reading the host's authoritative order. Deliberately scoped to
  // the dots and the toolbar's Pages list ONLY: `switchPage` (which addresses pages
  // by id), the deck-swipe handler's `findIndex`/modulo over `visiblePages`, and
  // handleSave's Unfiled-page lookup over the full `pages` list all stay as they
  // were — a draft order is not a fact the host has accepted yet.
  const pagerPages = useMemo(
    () =>
      editMode && draft
        ? pagesInOrder(visiblePages, draft.pageOrder)
        : visiblePages,
    [editMode, draft, visiblePages],
  );

  // ── FEATURE: Edit Layout (Task 4.3a) ──────────────────────────────────────
  // Declared here — before the engine call below — because the measure hook has
  // to be fed the draft's tile order while editing, and it references
  // `deckItems`/`currentPage` which an earlier callback could not reach without
  // a use-before-define.

  // A page the draft does not own yet is read straight from the host's rows (see
  // the module-level helpers), so no effect has to mirror server state into the
  // draft, and the render path and the drop path agree on one source of truth.
  const toggleEditMode = useCallback(() => {
    if (editMode) {
      // Leaving edit mode always tears the draft down with it.
      setDraft(null);
      setBaseDraft(null);
      setSelectedTileId(null);
      setActiveDragId(null);
      setPreviewOrder(null);
      setEditMode(false);
      return;
    }
    const seeded = createDraft(deckItems, visiblePages.map((p) => p.id));
    setDraft(seeded);
    setBaseDraft(seeded);
    setSelectedTileId(null);
    setPreviewOrder(null);
    setEditMode(true);
  }, [editMode, deckItems, visiblePages]);

  // Hand the toggle to the EditorBar / future control sheet (Tasks 4.3, 5.3).
  // Mirrored from an effect, never during render, so the deck's default
  // (non-edit) behavior stays untouched.
  const editModeApiRef = useRef(null);
  useEffect(() => {
    editModeApiRef.current = { editMode, toggleEditMode };
  }, [editMode, toggleEditMode]);

  // Tiles while editing: the draft's rows for the page being viewed, in draft
  // slot order. Reordering the draft therefore moves the real tiles, and this is
  // exactly the list handed to dnd-kit's SortableContext.
  const committedTiles = useMemo(() => {
    if (!editMode || !draft || currentPage == null) return null;
    return rowsForPage(draft, currentPage, deckItems);
  }, [editMode, draft, currentPage, deckItems]);

  // FEATURE: Edit Layout (Task 4.3b) — live drop preview. While a drag is in
  // flight this page has a tentative key order in `previewOrder`; the grid (and
  // dnd-kit's SortableContext) render THAT order so the exact target cells show
  // under the finger. The draft itself is untouched until onDragEnd (D8), and the
  // engine needs no recompute-key change: `useDeckLayout` keys its recompute on
  // the ORDERED size list (`items.map(it => it.size)`), so a mixed-size reorder
  // changes that key and re-packs, while a pure same-size reorder leaves the key
  // (and cols/cell/placements) identical — placements map by index either way, so
  // the swapped tiles still preview correctly.
  const editTiles = useMemo(() => {
    if (!committedTiles) return committedTiles;
    const order = previewOrder ? previewOrder[String(currentPage)] : null;
    if (!order) return committedTiles;
    const byKey = new Map(committedTiles.map((it) => [sortKeyOf(it), it]));
    const out = [];
    for (const key of order) {
      const row = byKey.get(key);
      if (row) {
        out.push(row);
        byKey.delete(key);
      }
    }
    // Safety: any committed row the preview did not name keeps its place at the
    // tail, so a malformed preview can never drop a tile from the grid.
    for (const row of byKey.values()) out.push(row);
    return out;
  }, [committedTiles, previewOrder, currentPage]);

  // The engine is fed the draft order while editing and the exact same
  // `deckItems` reference otherwise, so the non-edit render path is untouched.
  const renderItems = editTiles ?? deckItems;

  // The engine contract {cols, cell, gap, placements, scrollY}, measured from
  // deckRef pre-paint and re-measured on resize/rotation by useDeckLayout.
  // placements align with `renderItems` order; null until the first measure, so
  // the render below must guard.
  const layout = useDeckLayout(deckRef, {
    items: renderItems,
    settings: layoutSettings,
  });

  const sortableIds = useMemo(
    () => (editTiles ? editTiles.map(sortKeyOf) : EMPTY_SORTABLE_IDS),
    [editTiles],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 10 } }),
  );

  // Structural dirtiness, not reference dirtiness: a drag that landed back where
  // it started (or a no-op draft op) leaves `draft !== baseDraft` yet changes
  // nothing, and Save must not fire a pointless WS frame on that.
  const dirty = useMemo(() => {
    if (!baseDraft || !draft || draft === baseDraft) return false;
    const diff = diffDraft(baseDraft, draft);
    return (
      Object.keys(diff.reordersByPage).length > 0 ||
      diff.sizePatches.length > 0 ||
      diff.moves.length > 0 ||
      diff.detachments.length > 0 ||
      // FEATURE: Page reordering — a page-only edit must be saveable, so the deck's
      // order counts toward dirtiness on its own (diff.pageOrder is [] when
      // unchanged, so a no-op session still reports clean and Save stays disabled).
      diff.pageOrder.length > 0
    );
  }, [baseDraft, draft]);

  // The row under the finger, resolved from the SAME list the grid rendered, so
  // a page that is still represented by host rows (not yet folded into the
  // draft) still gets a ghost.
  const activeDragItem = useMemo(
    () =>
      editTiles && activeDragId
        ? editTiles.find((it) => sortKeyOf(it) === activeDragId)
        : null,
    [editTiles, activeDragId],
  );

  // The ghost has to be drawn at the tile's real footprint, otherwise a 2x2 key
  // would shrink to a 1x1 square the moment it left its cell. Read straight off
  // the engine placement for the dragged tile's current index.
  const activeDragSpan = useMemo(() => {
    if (!activeDragItem || !layout) return { cols: 1, rows: 1 };
    const key = sortKeyOf(activeDragItem);
    const i = renderItems.findIndex((it) => sortKeyOf(it) === key);
    const p = i >= 0 ? layout.placements[i] : null;
    return p ? p.span : { cols: 1, rows: 1 };
  }, [activeDragItem, layout, renderItems]);

  const handleDragStart = useCallback((event) => {
    const id = String(event.active.id);
    setActiveDragId(id);
    // Tapping a tile to select it and starting a drag on it are the same
    // gesture's two outcomes; claiming the selection up front means a click
    // that turns into a drag never flashes an unselected tile.
    setSelectedTileId(id);
    try {
      Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
    } catch {
      // ignore
    }
  }, []);

  // FEATURE: Edit Layout (Task 4.3b) — live drop preview. onDragOver folds the
  // tentative same-page reorder into `previewOrder` (an arrayMove over the page's
  // committed keys) so the deck renders the exact target cells while the finger
  // is down. It never touches `draft` — only `previewOrder` changes — so a
  // cancelled drag wrote nothing (D8). Cross-page active/over cannot occur here
  // (SortableContext is the current page only), and an unknown/absent `over`
  // simply leaves the preview untouched.
  const handleDragOver = useCallback(
    (event) => {
      if (!editTiles) return;
      const activeKey = String(event.active.id);
      const overKey = event.over ? String(event.over.id) : null;
      if (!overKey || overKey === activeKey) return;
      const keys = editTiles.map(sortKeyOf);
      const from = keys.indexOf(activeKey);
      const to = keys.indexOf(overKey);
      if (from < 0 || to < 0) return;
      const next = arrayMoveKeys(keys, from, to);
      setPreviewOrder((prev) => ({
        ...(prev || {}),
        [String(currentPage)]: next,
      }));
    },
    [editTiles, currentPage],
  );

  const handleDragEnd = useCallback(
    (event) => {
      const overId = event.over ? String(event.over.id) : null;
      setActiveDragId(null);
      // The preview is discarded either way: on a real commit `reorder` reproduces
      // the same arrangement in the draft; on a no-op drop it reverts to base.
      setPreviewOrder(null);
      lastDragEndAtRef.current = Date.now();
      const id = String(event.active.id);
      if (!overId || overId === id || !draft) return;

      // A page the draft does not own yet is rendered from the host's rows, so
      // fold it in before mutating — otherwise `reorder` would find neither id
      // and silently no-op the very first drag on every page after the first.
      const working = foldPageIntoDraft(draft, currentPage, deckItems);

      // Same page → reorder. Different page → `reorder` returns the same
      // reference and the drop is discarded (cross-page moves are Task 4.3b's
      // toolbar, not a drag), so no gating is needed here.
      const next = reorder(working, id, overId);
      if (next !== working) setDraft(next);
    },
    [draft, currentPage, deckItems],
  );

  const handleDragCancel = useCallback(() => {
    // An interrupted drag wrote nothing to the draft (that is exactly why the
    // model is in-memory — D8 makes recovery free), so this only clears the
    // overlay and any live preview the finger had left behind.
    lastDragEndAtRef.current = Date.now();
    setActiveDragId(null);
    setPreviewOrder(null);
  }, []);

  const showToast = useCallback((text) => {
    setEditToast(text);
    setTimeout(() => setEditToast((cur) => (cur === text ? null : cur)), 2500);
  }, []);

  const handleTileTap = useCallback((key) => {
    // A finished drag also emits a `click` on the tile, and letting that through
    // would deselect the very tile the user just moved. Whether dnd-kit swallows
    // that click is library-internal, so the guard is explicit here instead of
    // assumed: any tap within a short window after a drag ends is ignored.
    if (Date.now() - lastDragEndAtRef.current < 250) return;
    setSelectedTileId((cur) => (cur === key ? null : key));
  }, []);

  // The long-press door: enters edit mode with the pressed tile already
  // selected. Guarded on `editMode` because inside edit mode a long press is
  // just a tap on a tile (the tile is already a drag handle).
  const handleLongPressEnterEdit = useCallback(
    (key) => {
      if (editMode) return;
      const seeded = createDraft(deckItems, visiblePages.map((p) => p.id));
      setDraft(seeded);
      setBaseDraft(seeded);
      setSelectedTileId(key);
      setPreviewOrder(null);
      setEditMode(true);
    },
    [editMode, deckItems, visiblePages],
  );

  // ── FEATURE: Edit Layout (Task 4.3b) — per-item toolbar mutations ──────────
  // Each follows the handleDragEnd fold pattern: a page the draft does not own
  // yet is still host rows, so fold it before the op or it no-ops on the first
  // action for every page after the first. `resize` keeps the tile selected (the
  // user may pick another size); `moveToPage`/`detach` re-parent it off the
  // visible page, so selection is cleared (the row is no longer on this page).
  const handleResize = useCallback(
    (id, size) => {
      if (!draft) return;
      const working = foldPageIntoDraft(draft, currentPage, deckItems);
      const next = resize(working, id, size);
      if (next !== working) setDraft(next);
    },
    [draft, currentPage, deckItems],
  );

  const handleMoveToPage = useCallback(
    (id, targetPageId) => {
      if (!draft) return;
      // Fold the source page (already done for the drag/resize path) AND the
      // TARGET page before moving, so the draft's target order is always a
      // COMPLETE permutation. Without the target fold moveToPage builds a
      // one-tile target list from the draft's empty view of that page, so
      // diffDraft emits a partial reorder batch the host's all-or-nothing
      // applyReorder silently rejects (and the edit view is briefly incomplete).
      // Fold from baseDraft's rows — the server-derived membership already in
      // memory — so this stays local: no fetch, no host write before Save.
      // Unfiled is skipped: it is materialized fresh at Save and legitimately
      // starts empty, so its reorder batch already covers its (new) membership.
      // Pre-move no-ops (same page / unknown id) are preserved: moveToPage
      // returns the same reference and nothing is committed.
      let working = foldPageIntoDraft(draft, currentPage, deckItems);
      if (
        targetPageId !== UNFILED_TARGET &&
        baseDraft &&
        !draftHasPage(working, targetPageId)
      ) {
        const targetRows = baseDraft.items.filter(
          (it) => it.page_id === targetPageId,
        );
        // Only fold when the target has known membership to bring in; an empty
        // target (a never-viewed page) is left to self-heal on navigation, and
        // skipping createDraft keeps the no-op/reference-stable path intact.
        if (targetRows.length) {
          working = foldPageIntoDraft(working, targetPageId, targetRows);
        }
      }
      const next = moveToPage(working, id, targetPageId);
      if (next !== working) {
        setDraft(next);
        setSelectedTileId(null);
      }
    },
    [draft, currentPage, deckItems, baseDraft],
  );

  // detach's 3rd arg is a LAZY callback (per the module docblock) invoked only
  // when a detach actually proceeds. It returns the STABLE provisional id, never
  // a real page — the hidden "Unfiled" page is materialized only in handleSave,
  // so detaching before Save performs zero host writes.
  const requestUnfiledPage = useCallback(() => UNFILED_TARGET, []);

  const handleDetach = useCallback(
    (id) => {
      if (!draft) return;
      const working = foldPageIntoDraft(draft, currentPage, deckItems);
      const next = detach(working, id, requestUnfiledPage);
      if (next !== working) {
        setDraft(next);
        setSelectedTileId(null);
      }
    },
    [draft, currentPage, deckItems, requestUnfiledPage],
  );

  // FEATURE: Page reordering — no foldPageIntoDraft here: page order lives on
  // its own axis from the item rows, so it needs neither the viewed page's rows
  // nor a selection. The draft is the only place it changes.
  // `shiftPage` returns the SAME reference for an unknown id and for a move past
  // either end (exactly the buttons the toolbar disables), so the reference test
  // below is what keeps a dead-end tap from churning state.
  const handleShiftPage = useCallback(
    (pageId, delta) => {
      if (!draft) return;
      const next = shiftPage(draft, pageId, delta);
      if (next !== draft) setDraft(next);
    },
    [draft],
  );

  // The row the toolbar acts on, resolved from the SAME list the grid rendered
  // (host rows are still valid, they just lack a normalized `key`), and always
  // given one so the callbacks get the composite draft op id. If the selected id
  // no longer exists (e.g. it was just detached off this page) this resolves to
  // null, which hides the toolbar without a stale-selection flash.
  const selectedTile = useMemo(() => {
    if (!editMode || !selectedTileId) return null;
    const source = editTiles ?? deckItems;
    const row = source.find((it) => sortKeyOf(it) === selectedTileId);
    return row ? { ...row, key: sortKeyOf(row) } : null;
  }, [editMode, selectedTileId, editTiles, deckItems]);

  // Save replays the FULL draft diff to the host in the order the layoutDraft
  // contract requires: (a) materialize the hidden Unfiled page, (b) moves +
  // detachments re-parent tiles, (c) size patches, then (d) per-page reorder
  // batches applied LAST so each pins the authoritative dense order against the
  // page's POST-move membership (the host's applyReorder is all-or-nothing), and
  // finally (e) the one reorder_pages frame — after the item batches, so a Unfiled
  // page materialized by (a) is already hidden and pinned to the tail by the host
  // before the deck order is committed.
  //
  // Id typing (verified against host + the proven desktop sender):
  //   - POST /api/items/move requires `typeof id === "string"` (server.js:600),
  //     so `id` is String()-wrapped; `page_id`/`slot` are passed as-is.
  //   - reorder_items sends page_id and item ids RAW (server.js matches TEXT
  //     columns; diffDraft already emits string ids), exactly like
  //     DesktopApp.jsx's proven sender — NOT Number()-coerced (real page ids are
  //     TEXT like "page_main"/uuids, so Number() would NaN and null the frame).
  //   - Size PATCH routes (/api/buttons/:id, /api/widgets/:id) put the id in the
  //     URL path, inherently a string.
  const handleSave = useCallback(async () => {
    if (!baseDraft || !draft) return;
    const diff = diffDraft(baseDraft, draft);
    const reorderKeys = Object.keys(diff.reordersByPage);
    const hasMoves = diff.moves.length > 0;
    const hasDetaches = diff.detachments.length > 0;
    const hasSizes = diff.sizePatches.length > 0;
    // FEATURE: Page reordering — a page-only session has nothing but an order, and
    // it still has to be saveable.
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

    const socket = wsRef.current;
    if (socket?.readyState !== WebSocket.OPEN) {
      // Keep edit mode open: the draft is the user's work and must survive a
      // dropped socket rather than being thrown away with a failed send.
      setStatus("disconnected");
      socket?.reconnect?.(4000, "save layout");
      showToast("Offline — changes kept, not saved");
      return;
    }

    let unfiledRealId = null;
    // Resolve a provisional Unfiled id to the materialized real page id.
    const resolvePage = (pageId) =>
      pageId === UNFILED_TARGET ? unfiledRealId : pageId;

    // Guard the host-echo re-seed for the whole batch (see the reconcile site).
    saveInFlightRef.current = true;
    try {
      // (a) Materialize the hidden Unfiled page ONLY when something detaches.
      // Reuse an existing hidden "Unfiled" page if one is already known, else
      // create + hide it. This is the first host write of the Save; until here
      // no detach has touched the network.
      if (hasDetaches) {
        const existing = pages.find(
          (p) => p.hidden && (p.name || "").trim() === "Unfiled",
        );
        if (existing) {
          unfiledRealId = existing.id;
        } else {
          const createdRes = await authFetch("/pages", {
            method: "POST",
            body: JSON.stringify({ name: "Unfiled" }),
          });
          if (!createdRes.ok)
            throw new Error(`create Unfiled page (${createdRes.status})`);
          const created = await createdRes.json();
          unfiledRealId = created.id;
          const hideRes = await authFetch(
            `/pages/${encodeURIComponent(unfiledRealId)}`,
            { method: "PATCH", body: JSON.stringify({ hidden: true }) },
          );
          if (!hideRes.ok)
            throw new Error(`hide Unfiled page (${hideRes.status})`);
        }
      }

      // (b) Re-parent every moved/detached tile. One fetch per item (not batched).
      // Sorted by the draft's dense target slot ascending so each append lands
      // within the target page's current length (a first detach onto the empty
      // Unfiled page needs slot 0; ordering ascending keeps every slot in range).
      // Invariant: ascending order keeps each item's target slot <= the host's
      // current page length before that move (distinct dense slots), so the
      // batch cannot spuriously 400-abort.
      const transfers = [...diff.moves, ...diff.detachments].sort(
        (a, b) => a.toSlot - b.toSlot,
      );
      for (const m of transfers) {
        const res = await authFetch("/items/move", {
          method: "POST",
          body: JSON.stringify({
            kind: m.kind,
            id: String(m.id), // server.js:600 — move route requires a string id
            page_id: resolvePage(m.toPage),
            slot: m.toSlot,
          }),
        });
        if (!res.ok) throw new Error(`move ${m.kind}:${m.id} (${res.status})`);
      }

      // (c) Apply size patches. The route follows the kind.
      for (const s of diff.sizePatches) {
        const route = s.kind === "widget" ? "widgets" : "buttons";
        const res = await authFetch(
          `/${route}/${encodeURIComponent(String(s.id))}`,
          { method: "PATCH", body: JSON.stringify({ size: s.size }) },
        );
        if (!res.ok)
          throw new Error(`resize ${s.kind}:${s.id} (${res.status})`);
      }

      // (d) Item reorders after the REST writes: one reorder_items WS frame per
      // affected page, pinning the draft's dense final order against the
      // now-correct post-move membership. Item ids and page ids ride RAW (proven
      // desktop path); the Unfiled page's batch is re-keyed to its real id.
      for (const [pageId, items] of Object.entries(diff.reordersByPage)) {
        const realPageId = resolvePage(pageId);
        if (realPageId == null) continue;
        socket.send(
          JSON.stringify({
            v: 1,
            t: "reorder_items",
            page_id: realPageId,
            items,
          }),
        );
      }

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
    } catch (error) {
      // Optimistic-partial-apply: earlier sends that succeeded are already on the
      // host, but the BASELINE is not advanced past the point of truth. The next
      // host `state` broadcast (reconcile) re-seeds any page whose membership
      // diverged, so the stale diff self-heals. T8 could make the whole commit
      // transactional; 4.3b keeps the honest in-progress model from 4.3a.
      showToast(`Save failed: ${error?.message || "host error"}`);
      saveInFlightRef.current = false;
      return;
    }

    // Same post-send semantics as 4.3a: advance the baseline to the committed
    // draft (so a later Save only reports what changed since), keep edit mode
    // open, and toast that the batch is *waiting* — acceptance is settled by the
    // host echo, not by the send.
    saveInFlightRef.current = false;
    setBaseDraft(draft);
    showToast("Sent — waiting for host");
  }, [baseDraft, draft, pages, showToast]);

  // Discard: the draft is dropped and we leave. Deliberately performs no WS or
  // HTTP write at all — nothing was ever sent while editing, so there is nothing
  // to undo.
  const handleDone = useCallback(() => {
    setDraft(null);
    setBaseDraft(null);
    setSelectedTileId(null);
    setActiveDragId(null);
    setEditMode(false);
  }, []);

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
  const startVolumeHold = useCallback((direction, step, target) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      setStatus("connecting");
      wsRef.current?.reconnect?.(4000, "volume hold");
      return;
    }
    wsRef.current.send(
      JSON.stringify({ t: "volume_hold_start", direction, step, target }),
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
  //
  // FEATURE: Edit Layout — while editing, the tiles own the pointer (dnd-kit
  // drives drags off the same pointer stream), so the deck-level swipe is
  // suppressed entirely: a reorder must never flip the page underneath the
  // finger. Page switching stays available on the tap-only dots and rail below,
  // which are separate elements and are deliberately left working.
  const onDeckPointerDown = useCallback(
    (e) => {
      if (editMode) return;
      swipeRef.current = { x: e.clientX, y: e.clientY };
    },
    [editMode],
  );

  const onDeckPointerCancel = useCallback(() => {
    if (editMode) return;
    swipeRef.current = null;
  }, [editMode]);

  const onDeckPointerUp = useCallback(
    (e) => {
      if (editMode) return;
      const startPt = swipeRef.current;
      swipeRef.current = null;
      if (!startPt || visiblePages.length < 2) return;
      const dx = e.clientX - startPt.x;
      const dy = e.clientY - startPt.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;

      const i = visiblePages.findIndex((p) => p.id === currentPage);
      if (i === -1) return;
      const next =
        visiblePages[
          (i + (dx < 0 ? 1 : -1) + visiblePages.length) % visiblePages.length
        ];
      if (next) switchPage(next.id);
    },
    [editMode, visiblePages, currentPage, switchPage],
  );

  // FEATURE: Mobile customization (Task 5.3, issue #9) — the outer-column
  // pull-down gesture that opens the ControlSheet, arbitrated against every
  // other pointer consumer on the screen:
  //  - The listeners sit on the ROOT column in the CAPTURE phase, so a pull
  //    that starts on the top strip is claimed before the handle's or a tile's
  //    own pointerdown runs. pointerdown only RECORDS the origin — never
  //    preventDefault/stopPropagation — so the handle tap path still fires and
  //    toggles the sheet (Rule 1), and tile presses are untouched (Rule 4/5:
  //    tiles never sit in the strip, so their sequences fail the origin test).
  //  - pointermove claims the sequence once, only when the origin test passed
  //    AND the travel is a deliberate vertical pull (Rule 2). If the sheet is
  //    already open nothing is claimed — closing is the sheet's own affordance
  //    (handle tap, up-swipe inside it, Escape, outside tap).
  //  - In edit mode the gesture is not installed at all: a strip pointerdown
  //    may be the start of a tile drag, and opening the sheet mid-drag would
  //    jolt the reflowing layout — the same suppression the deck-level page
  //    swipe above already uses.
  useEffect(() => {
    const root = rootRef.current;
    // `paired` is a dep because the root column only mounts on the mobile
    // route after pairing; under ?desktop=1/Electron the ref stays null and
    // nothing is installed — the desktop surface keeps ProfileMenu untouched.
    if (!root || editMode) return;
    if (safeTopPxRef.current === null) {
      const pt = getComputedStyle(root).getPropertyValue("padding-top");
      safeTopPxRef.current = Number.parseFloat(pt) || 0;
    }
    const safeTopPx = safeTopPxRef.current;

    const onPointerDown = (e) => {
      // A fresh sequence always clears any unconsumed claim marker from the
      // last one — a pull whose trailing click never reached the handle.
      pullClaimedRef.current = false;
      const el = e.target instanceof Element ? e.target : null;
      const onHandle = !!el?.closest("[data-status-handle]");
      if (!originInPullZone(e.clientY, safeTopPx, onHandle)) return;
      pullPendingRef.current = { startX: e.clientX, startY: e.clientY };
    };

    const onPointerMove = (e) => {
      const origin = pullPendingRef.current;
      if (!origin || sheetOpenRef.current) return;
      if (
        isPullDownGesture(origin.startX, origin.startY, e.clientX, e.clientY)
      ) {
        // Complementary by construction to the deck's page-swipe test at App.jsx:1385 — that one rejects when |dx| < |dy| * 1.5, so a strictly vertical pull can never trigger a page change and vice versa.
        pullPendingRef.current = null; // claim once; further moves must not re-fire
        pullClaimedRef.current = true; // the trailing click must not re-toggle
        setSheetOpen(true);
      }
    };

    const clearPending = () => {
      pullPendingRef.current = null;
    };

    root.addEventListener("pointerdown", onPointerDown, true);
    root.addEventListener("pointermove", onPointerMove, true);
    root.addEventListener("pointerup", clearPending);
    root.addEventListener("pointercancel", clearPending);
    return () => {
      pullPendingRef.current = null;
      pullClaimedRef.current = false;
      root.removeEventListener("pointerdown", onPointerDown, true);
      root.removeEventListener("pointermove", onPointerMove, true);
      root.removeEventListener("pointerup", clearPending);
      root.removeEventListener("pointercancel", clearPending);
    };
  }, [editMode, paired]);

  // FEATURE: Mobile customization (Task 5.3) — the universal Edit Layout door
  // on the handle: a DOUBLE tap enters edit mode directly (a single tap keeps
  // toggling the sheet; the sheet's own "Edit Layout" button remains the
  // visible, keyboard-reachable door). This path only ever ENTERS edit mode —
  // it must never toggle out of an in-progress layout edit — and it closes the
  // sheet the first tap opened so the editor is not born underneath it.
  const enterEditModeFromHandle = useCallback(() => {
    setSheetOpen(false);
    if (editMode) return;
    editModeApiRef.current?.toggleEditMode();
  }, [editMode]);

  // The handle's tap path. A click whose pointer sequence the pull-down
  // gesture already claimed (see pullClaimedRef) is consumed here WITHOUT
  // toggling — otherwise the touch that opened the sheet by pulling would
  // close it again on release, since pointerup/click fire after the claim.
  // Fix round 1 (Minor #2): the return value is the pull-claim signal the
  // handle consults at click time — false = consumed by the pull (never arm
  // the double-tap window), true = a genuine toggle.
  const toggleSheetFromHandle = useCallback(() => {
    if (pullClaimedRef.current) {
      pullClaimedRef.current = false;
      return false;
    }
    setSheetOpen((open) => !open);
    return true;
  }, []);

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
        micVolume={micVolume}
        micMuted={micMuted}
        sessions={sessions}
        showLabels={showLabels}
        wsRef={wsRef}
        switchPage={switchPage}
        pageButtonsCacheRef={pageButtonsCacheRef}
        widgets={widgets}
        widgetData={widgetData}
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

  // FEATURE: Edit Layout — the deck grid is built once and then rendered either
  // bare (normal mode) or inside DndContext + SortableContext (edit mode).
  // DndContext and SortableContext render no DOM of their own, so the container
  // and its tiles are literally the same element tree either way; the only
  // difference is whether each tile is wrapped in the useSortable shell. That is
  // what keeps non-edit mode byte-for-byte identical.
  const deckGrid = (
    <div
      ref={deckRef}
      // Stable selector for the Task 7.1 viewport spec: the grid container
      // the tile rects are compared against. data-* is inert styling-wise.
      data-deck-grid
      onPointerDown={onDeckPointerDown}
      onPointerUp={onDeckPointerUp}
      onPointerCancel={onDeckPointerCancel}
      style={{
        flex: 1,
        minHeight: 0,
        overflowX: "hidden",
        // The engine degrades to vertical scroll only when height runs out
        // (D6); before the first measure there is no layout and the deck
        // stays exactly as clipped as it always was.
        overflowY: layout?.scrollY ? "auto" : "hidden",
        paddingLeft: "max(env(safe-area-inset-left), 10px)",
        paddingRight: "max(env(safe-area-inset-right), 10px)",
        paddingTop: 4,
        paddingBottom: 4,
        // The browser must not claim horizontal drags as scrolls: it cancels
        // the pointer sequence and the swipe never completes. Under scrollY the
        // browser keeps vertical panning — which is what lets a tall deck still
        // scroll while editing, because dnd-kit's distance:10 activation
        // constraint is what separates a reorder drag from a scroll and the
        // deck-level swipe handler is suppressed in edit mode entirely.
        touchAction: layout?.scrollY ? "pan-y" : "none",
        display: "grid",
        justifyContent: "center",
        gridTemplateColumns: layout
          ? `repeat(${layout.cols}, ${layout.cell}px)`
          : "none",
        gridAutoRows: layout ? `${layout.cell}px` : "auto",
        gap: layout ? layout.gap : 8,
      }}
    >
      {buttons.length === 0 && status === "connected" && <SkeletonGrid />}
      {layout &&
        renderItems.map((item, i) => {
          const p = layout.placements[i];
          if (!p) return null;
          const placeStyle = {
            gridColumn: `${p.col + 1} / span ${p.span.cols}`,
            gridRow: `${p.row + 1} / span ${p.span.rows}`,
          };
          // A draft row carries its own normalized `key`; a host row does not, so
          // the dnd-kit id is derived the same way in both cases. The React key
          // stays the historical per-kind `item.id` outside edit mode. Declared
          // up here so the widget tile can reuse it for tap-select in edit mode.
          const sortableId = sortKeyOf(item);
          const tile =
            item.kind === "button" ? (
              <SortableButton
                btn={item}
                pressing={pressing === item.id}
                editable={editMode}
                onPress={pressButton}
                volume={volume}
                muted={muted}
                micVolume={micVolume}
                micMuted={micMuted}
                sessions={sessions}
                showLabels={showLabels}
                onVolumeHoldStart={startVolumeHold}
                onVolumeHoldStop={stopVolumeHold}
                onConfirmHoldStart={beginConfirmHold}
                onLongPressEnterEdit={handleLongPressEnterEdit}
                onTap={handleTileTap}
              />
            ) : (
              /* FEATURE: Live widgets — tiles interleave with the keys in the
                 same grid. They are not pressable: a tile shows, it does not
                 act. In edit mode a tap selects the widget so the toolbar can
                 operate on it (4.3b carry-forward); `onSelect` is undefined
                 outside edit mode so the tile stays exactly as before. */
              <WidgetTile
                widget={item}
                data={widgetData[item.id]}
                sources={widgetSources}
                onSelect={
                  editMode ? () => handleTileTap(sortableId) : undefined
                }
              >
                <SystemMonitorWidget widget={item} data={widgetData[item.id]} />
              </WidgetTile>
            );

          return (
            <div
              key={item.key ?? item.id}
              // Task 7.1 spec hook: the placement wrapper is the identical
              // element tree in normal AND edit mode (DndContext renders no
              // DOM of its own), so locating tiles by host id works either
              // way. data-* carries no styling/behavior.
              data-deck-item={item.id}
              style={placeStyle}
            >
              {editMode ? (
                <DraggableTile
                  id={sortableId}
                  selected={selectedTileId === sortableId}
                >
                  {tile}
                </DraggableTile>
              ) : (
                tile
              )}
            </div>
          );
        })}
    </div>
  );

  return (
    <div
      ref={rootRef}
      style={{
        // `position: relative` anchors the edit-mode Save toast (the transient
        // `position: absolute` status element below), which is the only thing
        // this container is an offset parent for. DeckEditorBar is NOT absolutely
        // positioned over here — it is a `flexShrink: 0` row in this column (see
        // the flex-column structure and its comment near the bottom of this JSX).
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
        paddingTop: "env(safe-area-inset-top)",
        paddingBottom: "env(safe-area-inset-bottom)",
        // paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        background: "radial-gradient(circle at top left, #1f2230, #090909 70%)",
        fontFamily: "'SF Pro Display', 'Segoe UI', sans-serif",
      }}
    >
      <style>{globalStyles}</style>

      {/* FEATURE: Mobile customization (Tasks 5.1 + 5.2, issue #9) — the old
          44-px always-on top bar (logo, name, CPU/RAM/time pills, volume pill,
          connection pill, disconnect button) is gone. In its place: a 28-px
          collapsed StatusHandle whose whole strip is one aria-expanded button,
          and the ControlSheet it pushes open. Both are DIRECT flex-column
          children ahead of the deck — never fixed/absolute — so expanding the
          sheet shrinks the deck's measured box and `useDeckLayout`'s
          ResizeObserver re-fits the grid (spec §3 requirement 6). The safe
          area stays on the outer container's padding above. */}
      <StatusHandle
        isConnected={isConnected}
        micActive={micMuted === false && micVolume !== null && micVolume !== undefined}
        sheetOpen={sheetOpen}
        onToggle={toggleSheetFromHandle}
        onEnterEditMode={enterEditModeFromHandle}
      />

      <ControlSheet
        id="deck-control-sheet"
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        stats={stats}
        isConnected={isConnected}
        status={status}
        handleDisconnect={handleDisconnect}
        disconnectActive={disconnectActive}
        setDisconnectActive={setDisconnectActive}
        editModeApiRef={editModeApiRef}
      />

      {/* FEATURE: Responsive layout — one grid, one map: every tile is placed
          explicitly from layout.placements (gridLine/span pinned to the
          engine's column+row), so nothing relies on auto-flow or the old
          2x2-only span rule.
          FEATURE: Edit Layout (Task 4.3a) — the very same grid, wrapped in the
          dnd-kit context only while editing. Default measuring keeps each tile
          at its real rect, which is what rectSortingStrategy offsets against. */}
      {editMode ? (
        <DndContext
          sensors={sensors}
          collisionDetection={rectIntersection}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
            {deckGrid}
          </SortableContext>

          {/* DragOverlay — a solid ghost that follows the pointer, so the tile
              under the finger stays legible while the grid reflows around its
              (now transparent) source cell. Mirrors the desktop editor. */}
          <DragOverlay dropAnimation={{ duration: 180, easing: "ease" }}>
            {activeDragItem ? (
              <div
                style={{
                  // Match the grid's real footprint: a span of n cells is
                  // n*cell + (n-1)*gap, not n*cell — the source cell occupies
                  // that width in the CSS grid, so the ghost must too (the
                  // placement math at the deck map's placeStyle uses `span n`).
                  width: layout
                    ? layout.cell * activeDragSpan.cols +
                      layout.gap * (activeDragSpan.cols - 1)
                    : 88,
                  height: layout
                    ? layout.cell * activeDragSpan.rows +
                      layout.gap * (activeDragSpan.rows - 1)
                    : 88,
                  borderRadius: 18,
                  opacity: 0.95,
                  boxShadow: "0 14px 34px rgba(0,0,0,0.6)",
                }}
              >
                {activeDragItem.kind === "button" ? (
                  <SortableButton
                    btn={activeDragItem}
                    ghost
                    pressing={false}
                    editable
                    onPress={pressButton}
                    volume={volume}
                    muted={muted}
                    micVolume={micVolume}
                    micMuted={micMuted}
                    sessions={sessions}
                    showLabels={showLabels}
                    onVolumeHoldStart={startVolumeHold}
                    onVolumeHoldStop={stopVolumeHold}
                    onConfirmHoldStart={beginConfirmHold}
                  />
                ) : (
                  <WidgetTile
                    widget={activeDragItem}
                    data={widgetData[activeDragItem.id]}
                    sources={widgetSources}
                  >
                    <SystemMonitorWidget
                      widget={activeDragItem}
                      data={widgetData[activeDragItem.id]}
                    />
                  </WidgetTile>
                )}
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      ) : (
        deckGrid
      )}

      {/* FEATURE: Deck layout — swipe changes page; the dots do the same by tap,
          so the deck is never gesture-only. FEATURE: Page reordering — painted from
          `pagerPages`, which is `visiblePages` outside edit mode and the DRAFT's
          order while editing, so an Earlier / Later tap is visible on the dots
          immediately. Nothing else moves off `visiblePages`: switching, swiping and
          Save all keep reading the host's authoritative order. */}
      {pagerPages.length > 1 && (
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
          {pagerPages.map((p) => {
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
                    transition: "transform 0.16s ease, background 0.16s ease",
                  }}
                />
              </button>
            );
          })}
        </div>
      )}

      {/* FEATURE: Edit Layout (Task 4.3a) — the draft lifecycle bar. It is a
          `flexShrink: 0` flex row in this column, placed AFTER the deck and the
          page dots — NOT an absolutely-positioned overlay. An overlay would cover
          the dots, and the dots are the only page-switch affordance left while
          editing (the deck-level swipe handler is suppressed), so a multi-page
          deck could not be edited page-by-page. Taking this row shortens the
          deck's measured box, and that is fine: `useDeckLayout` observes the
          container with a ResizeObserver and re-measures on its own, so no engine
          cooperation is needed and the layout simply re-fits the smaller area.
          Task 4.3b extends this same component with the per-item toolbar for
          `selectedTileId`. */}
      <DeckEditorBar
        editMode={editMode}
        dirty={dirty}
        onDone={handleDone}
        onSave={handleSave}
        selected={selectedTile}
        layout={layout}
        pages={pages}
        orderedPages={pagerPages}
        currentPage={currentPage}
        onResize={handleResize}
        onMoveToPage={handleMoveToPage}
        onDetach={handleDetach}
        onShiftPage={handleShiftPage}
      />

      {/* Inline Save feedback — deliberately a transient toast, not a dialog: a
          failed Save must not cost the user the draft they are standing on. */}
      {editToast && (
        <div
          role="status"
          style={{
            position: "absolute",
            left: "50%",
            bottom: 68,
            transform: "translateX(-50%)",
            maxWidth: "90vw",
            padding: "8px 14px",
            borderRadius: 12,
            background: "rgba(22,22,30,0.94)",
            border: "1px solid rgba(255,255,255,0.12)",
            color: "#e0e0ec",
            fontSize: 13,
            fontWeight: 600,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 50,
          }}
        >
          {editToast}
        </div>
      )}

      {showDisconnectConfirm && (
        <div
          // Task 5.3: the sheet's outside-tap swallow exempts modal overlays —
          // this one sits above everything (z-index 9999) and owns its dismissal.
          data-outside-tap-exempt
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

// FEATURE: Mobile customization (Tasks 5.1 + 5.2) — StatPill and VolumePill
// used to live here as header-only display. Their one consumer moved into the
// ControlSheet, so StatPill moved with it (see mobile/ControlSheet.jsx) and
// VolumePill's bar+% readout was upgraded to the sheet's slider row rather
// than being kept in two places.

// ── FEATURE: Edit Layout (Task 4.3a) — the drag-capable tile shell ──────────
// `useSortable` is a hook, so it cannot be called conditionally from inside
// SortableButton: normal mode has to render the very same tile with zero dnd-kit
// involvement, which means the hook lives in its own component and App mounts
// either `<DraggableTile>{tile}</DraggableTile>` (editing) or `{tile}` (not).
//
// The tile IS the handle — there is no separate grab area — so `attributes` and
// `listeners` go on the wrapper, which is exactly the tile box. The wrapper is
// width/height 100% and both the button face and WidgetTile size themselves to
// their parent, so inserting it moves no pixels at rest.
const DraggableTile = memo(function DraggableTile({ id, selected, children }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: 18,
        transform: CSS.Transform.toString(transform),
        transition,
        // Every editable tile wears a dashed ring; the selected one gets the
        // stronger solid ring, and the rest lose saturation so "pick one" reads
        // at a glance. Nothing else about the tile changes.
        outline: selected
          ? "2px solid rgba(96,165,250,0.9)"
          : "1px dashed rgba(255,255,255,0.35)",
        outlineOffset: -1,
        filter: selected ? "none" : "saturate(0.6)",
        // The source cell goes transparent so the floating DragOverlay ghost is
        // the only copy the eye follows; dnd-kit suppresses its own listeners on
        // the hidden original, so a drag can never be "dropped twice".
        opacity: isDragging ? 0 : 1,
        zIndex: isDragging ? 999 : "auto",
        cursor: "grab",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
    >
      {children}
      {/* The selected marker: Task 4.3b's toolbar acts on this tile, so the
          selection has to be unmistakable, not just a slightly different ring. */}
      {selected && (
        <div
          style={{
            position: "absolute",
            top: 6,
            right: 6,
            width: 22,
            height: 22,
            borderRadius: "50%",
            display: "grid",
            placeItems: "center",
            background: "#3b82f6",
            color: "#fff",
            pointerEvents: "none",
            zIndex: 6,
          }}
        >
          <Icon name="check" size={12} />
        </div>
      )}
    </div>
  );
});

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
  editable,
  ghost,
  onPress,
  volume,
  muted,
  micVolume,
  micMuted,
  sessions,
  showLabels,
  onVolumeHoldStart,
  onVolumeHoldStop,
  onConfirmHoldStart,
  onLongPressEnterEdit,
  onTap,
}) {
  // Reordering lives on the desktop; on the phone a key is only ever pressed,
  // which leaves horizontal swipes free to page between profiles.
  const isDragging = false;

  const [ripple, setRipple] = useState(null);
  // FEATURE: Hold to confirm — local to the tile; nothing above needs to know.
  const [holding, setHolding] = useState(false);
  const holdTimerRef = useRef(null);

  // FEATURE: Edit Layout (Task 4.3a) — the long-press DOOR into edit mode.
  // It is armed on a plain (not yet editable) tile only; once editing, a long
  // press is just a press that dnd-kit already owns. Kept entirely local so a
  // normal tap never touches parent state and never re-renders the deck.
  const editPressTimerRef = useRef(null);
  const pressStartRef = useRef(null);
  // The composite draft/dnd-kit key for this tile. Rows that came from the
  // draft already carry it (`key`); a normal server row does not, so it is
  // derived from the same kind+id pair — which is what lets a long press on an
  // un-edited deck name the tile it is about to select.
  const sortableId = btn.key ?? tileSortKey(btn);

  const clearEditPressTimer = useCallback(() => {
    clearTimeout(editPressTimerRef.current);
    editPressTimerRef.current = null;
    pressStartRef.current = null;
  }, []);

  // The existing hold-unmount cleanup, extended: an unmounting tile must not
  // leave a pending edit-mode entry behind that fires into a dead component.
  useEffect(
    () => () => {
      clearTimeout(holdTimerRef.current);
      clearTimeout(editPressTimerRef.current);
    },
    [],
  );

  // Sizing/spans live on the deck grid now (explicit placement in App's map),
  // not on the tile — a 2x2 key is placed, not special-cased here.
  const isToggleOn =
    Number(btn.is_toggle) === 1 && Number(btn.toggle_state) === 1;
  const isToggle = Number(btn.is_toggle) === 1;

  const isVideo = btn.icon_data?.startsWith("data:video/");

  const levelTarget = levelTargetFor(btn.action_type);
  const isMicBtn = levelTarget === "mic";
  const isVolumeBtn = levelTarget !== null;
  const isVolumeHoldBtn = HOLD_REPEAT_ACTIONS.has(btn.action_type);
  // An app key reads the level of whichever application it targets, so a change
  // to a silent app is still visible — without this an App Audio key looked
  // like it did nothing at all.
  const appSession =
    levelTarget === "app"
      ? sessions.find(
          (s) =>
            s.app.toLowerCase() ===
            unpackAppValue(btn.action_value).app.toLowerCase(),
        )
      : null;
  const level =
    levelTarget === "app"
      ? (appSession?.volume ?? null)
      : isMicBtn
        ? micVolume
        : volume;
  const levelMuted =
    levelTarget === "app" ? !!appSession?.muted : isMicBtn ? micMuted : muted;
  const volumeStep = volumeStepFor(btn);

  // FEATURE: Hold to confirm — volume buttons own the pointer-hold gesture
  // already, so the two are mutually exclusive by construction.
  const requiresConfirm = Number(btn.require_confirm) === 1 && !isVolumeHoldBtn;

  // FEATURE: Soundboard — show a small speaker indicator if the button has a sound
  const hasSound = !!btn.sound_file;

  const mergedTransition = [
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

  const handleClick = useCallback(
    (e) => {
      if (isDragging) return;
      // Edit Layout: a tile only drags/selects — no press, no ripple. A tap (a
      // drag that never reached the 10 px activation distance) selects instead.
      // A completed drag also emits this click, so App ignores taps for a short
      // window after a drag ends rather than depending on dnd-kit swallowing it.
      if (editable) {
        if (onTap) onTap(sortableId);
        return;
      }
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
    [
      isDragging,
      editable,
      onTap,
      sortableId,
      onPress,
      btn.id,
      isVolumeHoldBtn,
      requiresConfirm,
    ],
  );

  const handlePointerDown = useCallback(
    (e) => {
      if (isDragging) return;
      // Edit Layout: suppress pointer-capture, hold-confirm timer and volume
      // hold start entirely — the only behavior left on a tile is drag/select,
      // which dnd-kit owns (the isDragging guard above is untouched).
      if (editable) return;
      // The 500 ms door. Armed ONLY on tiles that have no long-press gesture of
      // their own: a guarded key completes at 700 ms and a volume key repeats
      // from the moment it is touched, so taking the hold away from either would
      // be a regression, not a feature. For those two families the entry point
      // stays the ✏️ chip / control sheet (Task 5.3). On a plain key a long hold
      // used to do nothing at all, so this adds a door without changing one.
      if (onLongPressEnterEdit && !isVolumeHoldBtn && !requiresConfirm) {
        pressStartRef.current = { x: e.clientX, y: e.clientY };
        clearTimeout(editPressTimerRef.current);
        editPressTimerRef.current = setTimeout(() => {
          clearEditPressTimer();
          onLongPressEnterEdit(sortableId);
        }, LONG_PRESS_ENTER_EDIT_MS);
      }
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
        btn.action_type.endsWith("_up") ? "up" : "down",
        volumeStep,
        levelTarget,
      );
    },
    [
      isDragging,
      editable,
      onLongPressEnterEdit,
      clearEditPressTimer,
      sortableId,
      isVolumeHoldBtn,
      requiresConfirm,
      volumeStep,
      levelTarget,
      btn.id,
      btn.action_type,
      onPress,
      onConfirmHoldStart,
      onVolumeHoldStart,
    ],
  );

  // FEATURE: Edit Layout — travelling past 10 px is a swipe/scroll/drag, not a
  // hold, so the edit door is abandoned. Same threshold dnd-kit uses to
  // activate, which keeps the two gestures from ever both firing.
  const handlePointerMove = useCallback(
    (e) => {
      const start = pressStartRef.current;
      if (!start) return;
      if (
        Math.abs(e.clientX - start.x) > LONG_PRESS_CANCEL_PX ||
        Math.abs(e.clientY - start.y) > LONG_PRESS_CANCEL_PX
      ) {
        clearEditPressTimer();
      }
    },
    [clearEditPressTimer],
  );

  const handlePointerUp = useCallback(() => {
    clearEditPressTimer();
    if (requiresConfirm) {
      cancelHold();
      return;
    }
    if (!isVolumeHoldBtn) return;
    setRipple(null);
    onVolumeHoldStop();
  }, [
    clearEditPressTimer,
    requiresConfirm,
    cancelHold,
    isVolumeHoldBtn,
    onVolumeHoldStop,
  ]);

  return (
    <div
      onClick={handleClick}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      style={{
        transform: pressing ? "scale(0.96)" : undefined,
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
        backdropFilter: isDragging || ghost ? "none" : "blur(18px)",
        WebkitBackdropFilter: isDragging || ghost ? "none" : "blur(18px)",
        opacity: isDragging ? 0.85 : ghost ? 0.95 : 1,
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
          <ButtonFace
            icon={btn.icon}
            size={btn.size === "2x2" ? 56 : 42}
            style={{
              fontSize:
                btn.size === "2x2" ? "min(64px, 14vw)" : "min(48px, 11vw)",
            }}
          />
        )}
      </div>

      {/* Labels are a deck-wide preference set on the desktop; volume keys draw
          their own above the rail, so this covers everything else. */}
      {showLabels && !isVolumeBtn && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "14px 6px 7px",
            background: "linear-gradient(transparent, rgba(0,0,0,0.72))",
            textAlign: "center",
            fontSize: 11,
            fontWeight: 600,
            color: "rgba(255,255,255,0.82)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 3,
          }}
        >
          {btn.label}
        </div>
      )}

      {/* FEATURE: Volume controls — live fill bar + % overlay */}
      {isVolumeBtn && level !== null && (
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
            alignItems: "stretch",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "baseline",
              gap: 5,
              justifyContent: showLabels ? "space-between" : "center",
            }}
          >
            {showLabels && (
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  color: "rgba(255,255,255,0.75)",
                  textShadow: "0 1px 3px rgba(0,0,0,0.8)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {btn.label}
              </span>
            )}
            <span
              style={{
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.4,
                color: levelMuted ? "#f87171" : "rgba(255,255,255,0.82)",
                textShadow: "0 1px 3px rgba(0,0,0,0.7)",
                fontVariantNumeric: "tabular-nums",
                flexShrink: 0,
              }}
            >
              {levelMuted ? "MUTED" : `${level}%`}
            </span>
          </div>
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
                transform: `scaleX(${(levelMuted ? 0 : level) / 100})`,
                background: levelMuted ? "#f87171" : "rgba(255,255,255,0.92)",
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
    </div>
  );
});

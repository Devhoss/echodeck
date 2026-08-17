/**
 * DesktopApp.jsx  —  client/src/desktop/DesktopApp.jsx
 *
 * Full Elgato-style desktop layout:
 *   LEFT   — profile/page sidebar with auto-switch rules
 *   CENTER — button grid with drag-to-reorder (reuses SortableButton from App.jsx)
 *   RIGHT  — property panel (inline editor, no full-screen overlay)
 *
 * Receives all live state (buttons, pages, stats, volume, ws) as props from App.jsx.
 * All mutations go through the existing REST/WebSocket API — no new API surface.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  memo,
  useMemo,
} from "react";
import QRCode from "qrcode";
import deckIcon from "/deck-icon.png";
import {
  DndContext,
  closestCenter,
  pointerWithin,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  rectSortingStrategy,
  arrayMove,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActionIcon, ButtonFace, Icon } from "../icons.jsx";
import {
  ACTION_BY_ID,
  ACTION_CATEGORIES,
  actionIconFor,
  DEFAULT_BUTTON_ICON,
  levelTargetFor,
  packAppValue,
  unpackAppValue,
  actionTypeLabel,
  applyActionTypeDefaults,
} from "../actionRegistry.js";
import { getApiUrl } from "../constants.js";

// Resolved at call time (inside effects/handlers), always after preload injection
const api = () => getApiUrl();

// ─── Constants ────────────────────────────────────────────────────────────────

const COLORS = [
  "#5B4FCF",
  "#0F6E56",
  "#185FA5",
  "#854F0B",
  "#7C1D3F",
  "#1D5C7C",
  "#2D6B2D",
  "#6B2D2D",
  "#4a3a8a",
  "#1a6b4a",
  "#0a4a8a",
  "#6b4a0a",
];

const SOUND_TARGETS = [
  { value: "phone", label: "Phone", icon: "phone" },
  { value: "pc", label: "PC", icon: "desktop" },
  { value: "both", label: "Both", icon: "pages" },
];

const CONDITION_TYPES = [
  { value: "process", label: "Process" },
  { value: "window_title", label: "Window title" },
  { value: "executable_path", label: "Executable path" },
];
const CONDITION_OPERATORS = [
  { value: "equals", label: "equals" },
  { value: "contains", label: "contains" },
  { value: "starts_with", label: "starts with" },
  { value: "ends_with", label: "ends with" },
  { value: "regex", label: "regex" },
  { value: "not_equals", label: "not equals" },
  { value: "not_contains", label: "not contains" },
  { value: "exists", label: "exists" },
];
const emptyCondition = () => ({
  type: "process",
  operator: "equals",
  value: "",
});

function parseDeviceName(userAgent) {
  if (!userAgent) return "Phone";

  // Android: "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit..."
  //          "Mozilla/5.0 (Linux; Android 12; SM-S908B) AppleWebKit..."
  const androidModel = userAgent.match(/\(Linux;[^;]+;\s*([^)]+)\)/);
  if (androidModel) {
    const model = androidModel[1].trim();
    // Strip build suffixes like "SM-S908B Build/..."
    return model.replace(/\s+Build\/.*$/, "").trim();
  }

  // iOS: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"
  if (userAgent.includes("iPhone")) return "iPhone";
  if (userAgent.includes("iPad")) return "iPad";

  return "Phone";
}

const globalStyles = `

  @keyframes pulse      { 0%,100%{opacity:1} 50%{opacity:0.35} }
  @keyframes ripple     { 0%{transform:scale(0);opacity:0.5} 100%{transform:scale(3);opacity:0} }
  @keyframes toggleGlow { 0%,100%{opacity:0.6} 50%{opacity:1} }
  @keyframes fadeIn     { from{opacity:0;transform:translateY(8px)} to{opacity:1;transform:translateY(0)} }
  @keyframes slideIn    { from{opacity:0;transform:translateX(10px)} to{opacity:1;transform:translateX(0)} }
  @keyframes popIn      { 0%{transform:scale(0.93);opacity:0} 60%{transform:scale(1.02)} 100%{transform:scale(1);opacity:1} }

  * { -webkit-tap-highlight-color: transparent; box-sizing: border-box; }
  html,body { overflow:hidden; height:100%; margin:0; }

  ::-webkit-scrollbar { width:3px; height:3px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:#2e2e2e; border-radius:3px; }
  ::-webkit-scrollbar-thumb:hover { background:#414141; }

  input, select, textarea {
    color-scheme: dark;
    background: #222222;
    color: #d4d4d4;
    border: 1px solid #333333;
    border-radius: 7px;
    padding: 7px 10px;
    font-size: 12px;
    font-family: 'DM Sans', system-ui, sans-serif;
    width: 100%;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus, select:focus, textarea:focus {
    border-color: #3d8fd6;
    box-shadow: 0 0 0 2px rgba(79,128,255,0.15);
  }
  input[type=color] { padding:2px; height:26px; width:26px; cursor:pointer; border-radius:5px; }
  select option { background: #222222; }

  button { font-family: 'DM Sans', system-ui, sans-serif; }
`;

// ─── Main Component ───────────────────────────────────────────────────────────

export default function DesktopApp({
  buttons,
  setButtons,
  pages,
  setPages,
  currentPage,
  setCurrentPage,
  status,
  stats,
  volume,
  muted,
  micVolume,
  micMuted,
  sessions,
  showLabels,
  wsRef,
  switchPage,
  pageButtonsCacheRef,
}) {
  const buttonCount = buttons.length;
  const canvasRef = useRef(null);
  // Keys are sized to the space the canvas actually has, so the whole deck is
  // always visible. Previously they were a fixed 104px and the canvas scrolled,
  // which meant adding a key could push it out of sight behind the drawer.
  const [deckLayout, setDeckLayout] = useState({ cols: 1, size: 96 });

  const [selectedBtn, setSelectedBtn] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeId, setActiveId] = useState(null); // dnd drag overlay
  const [audioDevices, setAudioDevices] = useState([]);
  const [inputDevices, setInputDevices] = useState([]);
  const [audioSessions, setAudioSessions] = useState([]);
  const [profileRules, setProfileRules] = useState([]);
  const [ruleEditorKey, setRuleEditorKey] = useState(0);
  const [autoSwitch, setAutoSwitch] = useState(true);
  const reorderTimer = useRef(null);
  const captureTimerRef = useRef(null);
  const [selectedPage, setSelectedPage] = useState(null);
  const [showQR, setShowQR] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState(null);
  const [pairUrl, setPairUrl] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);
  const [addingPage, setAddingPage] = useState(false);
  const [newPageName, setNewPageName] = useState("");
  const [activeWindow, setActiveWindow] = useState(null);
  const [openWindows, setOpenWindows] = useState([]);
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [captureCountdown, setCaptureCountdown] = useState(0);
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [pcSoundDevice, setPcSoundDevice] = useState("");
  // FEATURE: Soundboard — real output devices as Chromium sees them. These are
  // what setSinkId can actually route to, so the picker has to come from here
  // rather than from the PowerShell device list used by audio_switch_device.
  const [outputDevices, setOutputDevices] = useState([]);
  const [pcMonitorDevice, setPcMonitorDevice] = useState("");
  const [audioSettingsSaved, setAudioSettingsSaved] = useState(false);
  const [showDevices, setShowDevices] = useState(false);
  // FEATURE: Auto-switch rules moved out of the sidebar — they are configured
  // occasionally, so they no longer hold permanent canvas space.
  const [showRules, setShowRules] = useState(false);
  // Lifted so the page rail's + can open the profile menu straight into its
  // "name this profile" state — before, it set addingPage on a closed menu and
  // looked like it did nothing.
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [connectedDevices, setConnectedDevices] = useState([]);
  // FEATURE: Pairing — devices that hold a persisted credential. Distinct from
  // connectedDevices, which is only the sockets open right now.
  const [pairedDevices, setPairedDevices] = useState([]);
  // FEATURE: Editor — snapshot of the form as last loaded or saved, so the
  // panel can tell you there is something unsaved rather than letting a
  // toggle look like it applied instantly.
  const [savedForm, setSavedForm] = useState(null);

  // Derive button counts from the cache ref + live buttons for current page
  // Try every column count and keep whichever yields the largest key: the
  // window is freely resizable, so a fixed guess is wrong at most sizes. Capped
  // at 8 across, mirroring a Stream Deck XL, and capped in size so a two-key
  // profile does not blow its keys up to fill the window.
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (!el) return;

    const measure = () => {
      const gap = 12;
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const box = el.getBoundingClientRect();
      const w = box.width - padX;
      const h = box.height - padY;
      if (w <= 0 || h <= 0) return;

      // +1 for the trailing add slot, which occupies a cell like any key.
      const count = Math.max(1, buttonCount + 1);
      let best = { cols: 1, size: 0 };
      for (let cols = 1; cols <= Math.min(count, 8); cols++) {
        const rows = Math.ceil(count / cols);
        const size = Math.floor(
          Math.min(
            (w - (cols - 1) * gap) / cols,
            (h - (rows - 1) * gap) / rows,
          ),
        );
        // >= not >: several column counts often tie on size because the height
        // is the binding constraint, and on a tie the widest deck is the right
        // one. Strict > kept the first (narrowest) match and left the keys
        // huddled in the middle of a wide window.
        if (size >= best.size) best = { cols, size };
      }

      const size = Math.min(104, Math.max(48, best.size));
      setDeckLayout((prev) =>
        prev.cols === best.cols && Math.abs(prev.size - size) <= 1
          ? prev
          : { cols: best.cols, size },
      );
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [buttonCount]);

  const pageButtonCounts = useMemo(() => {
    const m = {};
    if (pageButtonsCacheRef?.current) {
      for (const [id, btns] of pageButtonsCacheRef.current.entries()) {
        m[id] = btns.length;
      }
    }
    // Always override current page with live buttons prop
    if (currentPage) m[currentPage] = buttons.length;
    return m;
  }, [buttons, currentPage, pageButtonsCacheRef]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  );

  // Dragging an action must only land on something the pointer is actually
  // over — closestCenter always returns the nearest droppable, which meant
  // releasing anywhere replaced whichever key happened to be closest.
  // Reordering keys keeps closestCenter, where "nearest" is what you want.
  const collisionDetection = useCallback((args) => {
    if (String(args.active.id).startsWith("action:"))
      return pointerWithin(args);
    return closestCenter(args);
  }, []);

  // FEATURE: Soundboard — enumerate playback devices, refreshing when the user
  // plugs in or removes hardware. Labels are only populated once the media
  // permission is granted, which main.js does for our own renderer.
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.enumerateDevices) return;

    let cancelled = false;
    const load = async () => {
      try {
        const devices = await media.enumerateDevices();
        if (cancelled) return;
        const labels = devices
          .filter((d) => d.kind === "audiooutput" && d.label)
          .map((d) => d.label);
        setOutputDevices([...new Set(labels)]);
      } catch {
        /* leave the list empty; the picker keeps whatever is saved */
      }
    };

    load();
    media.addEventListener?.("devicechange", load);
    return () => {
      cancelled = true;
      media.removeEventListener?.("devicechange", load);
    };
  }, []);

  // Load supporting data once
  useEffect(() => {
    fetch(`${api()}/audio-devices`)
      .then((r) => r.json())
      .then(setAudioDevices)
      .catch(() => {});
    fetch(`${api()}/audio-devices?direction=input`)
      .then((r) => r.json())
      .then(setInputDevices)
      .catch(() => {});
    fetch(`${api()}/audio-sessions`)
      .then((r) => r.json())
      .then(setAudioSessions)
      .catch(() => {});
    fetch(`${api()}/profile-rules`)
      .then((r) => r.json())
      .then(setProfileRules)
      .catch(() => {});
    fetch(`${api()}/settings`)
      .then((r) => r.json())
      .then((d) => {
        setAutoSwitch(d.auto_profile_switching !== false);
        setPcSoundDevice(d.pc_sound_device ?? "");
        setPcMonitorDevice(d.pc_monitor_device ?? "");
      })
      .catch(() => {});

    // Load connected devices and refresh every 5s
    const refreshDevices = () => {
      fetch(`${api()}/clients`)
        .then((r) => r.json())
        .then(setConnectedDevices)
        .catch(() => {});
      fetch(`${api()}/paired-devices`)
        .then((r) => r.json())
        .then(setPairedDevices)
        .catch(() => {});
    };
    refreshDevices();
    const devicesInterval = setInterval(refreshDevices, 5000);
    return () => {
      clearInterval(captureTimerRef.current);
      clearInterval(devicesInterval);
    };
  }, []);

  const patchForm = useCallback(
    (patch) => setForm((f) => ({ ...f, ...patch })),
    [],
  );

  // When a different button is selected, populate the form
  const selectBtn = useCallback(
    (btn) => {
      setSelectedBtn(btn.id);
      setSelectedPage(currentPage);
      const nextForm = {
        label: btn.label,
        icon: btn.icon,
        icon_data: btn.icon_data || null,
        color: btn.color,
        action_type: btn.action_type,
        action_value: btn.action_value,
        size: btn.size || "1x1",
        is_toggle: btn.is_toggle || 0,
        toggle_action_type: btn.toggle_action_type || "keystroke",
        toggle_action_value: btn.toggle_action_value || "",
        actions: btn.actions || null,
        button_mode:
          btn.button_mode ||
          (btn.switch_actions_a?.length || btn.switch_actions_b?.length
            ? "multi_switch"
            : "single"),
        switch_actions_a: btn.switch_actions_a || [],
        switch_actions_b: btn.switch_actions_b || [],
        switch_state: btn.switch_state || 0,
        sound_file: btn.sound_file || null,
        sound_target: btn.sound_target || "phone",
        audio_device: btn.audio_device || null,
        require_confirm: btn.require_confirm || 0,
      };
      setForm(nextForm);
      setSavedForm(nextForm);
      setSaved(false);
    },
    [currentPage],
  );

  // FEATURE: Editor — put the form back to the last loaded or saved snapshot.
  // Confirmed rather than immediate: the drawer can hold a whole multi-action
  // stack, so discarding is not always the small change it looks like.
  //
  // An uploaded icon is deliberately not undone. That upload already wrote to
  // the database on its own, so there is nothing local left to revert, and
  // pretending otherwise would show the old icon over the new stored one.
  function revertForm() {
    if (!savedForm || !isDirty) return;
    askConfirm(
      "Discard unsaved changes to this key?",
      () => setForm(savedForm),
      { confirmLabel: "Discard", tone: "neutral" },
    );
  }

  // `options` carries the affirmative button's wording and tone. Every caller
  // but one is a deletion, so the defaults leave them untouched — but a revert
  // offering a red "Delete" button was actively alarming.
  function askConfirm(message, onConfirm, options = {}) {
    setConfirmModal({ message, onConfirm, ...options });
  }

  async function openPairQR() {
    const api = getApiUrl();
    const data = await fetch(`${api}/pair-info`).then((r) => r.json());
    const url = `echodeck://pair?host=${data.host}&port=${data.port}&token=${data.token}`;
    setPairUrl(url);
    const dataUrl = await QRCode.toDataURL(url, {
      width: 240,
      margin: 2,
      color: { dark: "#ffffff", light: "#14141400" },
    });
    setQrDataUrl(dataUrl);
    setShowQR(true);
  }

  // Deselect when page changes — track which page the selection belongs to
  // and derive nullification instead of calling setState inside an effect

  const resolvedSelected = selectedPage === currentPage ? selectedBtn : null;
  const resolvedForm = useMemo(
    () => (selectedPage === currentPage ? form : {}),
    [selectedPage, currentPage, form],
  );

  // FEATURE: Editor — is there anything to save? Compared key-order
  // independently so a patch that reorders keys does not read as a change.
  const isDirty = useMemo(() => {
    if (!savedForm || !resolvedSelected) return false;
    const norm = (o) =>
      JSON.stringify(
        Object.keys(o)
          .sort()
          .map((k) => [k, o[k]]),
      );
    return norm(resolvedForm) !== norm(savedForm);
  }, [resolvedForm, savedForm, resolvedSelected]);

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async function addPage() {
    const name = newPageName.trim();
    if (!name) return;
    setAddingPage(false);
    setNewPageName("");
    await fetch(`${api()}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await reloadPages();
    const newPage = data[data.length - 1];
    if (newPage) {
      setCurrentPage(newPage.id);
    }
  }

  async function reloadPages() {
    const res = await fetch(`${api()}/pages`);
    const data = await res.json();
    setPages(data);

    return data;
  }

  async function deletePage(id) {
    askConfirm("Delete this page and all its buttons?", async () => {
      await fetch(`${api()}/pages/${id}`, { method: "DELETE" });
      const data = await reloadPages();
      setCurrentPage(data[0]?.id ?? null);
      setSelectedBtn(null);
    });
  }

  async function addButton() {
    if (!currentPage) return;
    await fetch(`${api()}/buttons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_id: currentPage }),
    });
    const data = await reloadPages();
    const page = data.find((p) => p.id === currentPage);
    const btns = page?.buttons || [];
    setButtons(btns);
    const newest = btns[btns.length - 1];
    if (newest) selectBtn(newest);
  }

  // Dropping an action onto a key rewrites that key's action, keeping its
  // label, icon and colour — you are changing what the key does, not replacing
  // the key. A key that already does something asks first.
  const assignAction = useCallback(
    async (buttonId, actionType) => {
      const target = buttons.find((b) => b.id === buttonId);
      if (!target) return;

      const apply = async () => {
        const patch = applyActionTypeDefaults(
          {
            action_type: target.action_type,
            action_value: target.action_value,
          },
          actionType,
        );
        // Follow the action only while the face is still untouched — the
        // starting bolt, or the previous action's own glyph. A custom emoji or
        // an uploaded image is the user's choice and is left alone.
        const untouched =
          !target.icon_data &&
          (!target.icon ||
            target.icon === DEFAULT_BUTTON_ICON ||
            target.icon === actionIconFor(target.action_type));
        if (untouched) {
          patch.icon = actionIconFor(actionType) ?? DEFAULT_BUTTON_ICON;
        }
        await fetch(`${api()}/buttons/${buttonId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = await reloadPages();
        const page = data.find((p) => p.id === currentPage);
        setButtons(page?.buttons || []);
        const updated = (page?.buttons || []).find((b) => b.id === buttonId);
        if (updated) selectBtn(updated);
      };

      const isBlank =
        !target.action_value && target.action_type === "keystroke";
      if (isBlank) return apply();

      askConfirm(
        `Replace “${target.label}” with ${actionTypeLabel(actionType)}?`,
        apply,
      );
    },
    [buttons, currentPage, selectBtn, reloadPages, setButtons],
  );

  // Dropping onto the empty well creates a key already set to that action.
  const createWithAction = useCallback(
    async (actionType) => {
      if (!currentPage) return;
      // One request, not a create-then-patch. The second round trip meant the
      // key existed briefly as a blank default — it painted the bolt icon and
      // "Hotkey" for a frame before becoming the action that was dropped.
      const res = await fetch(`${api()}/buttons`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          page_id: currentPage,
          icon: actionIconFor(actionType) ?? DEFAULT_BUTTON_ICON,
          ...applyActionTypeDefaults({}, actionType),
        }),
      });
      const created = await res.json().catch(() => null);

      const data = await reloadPages();
      const page = data.find((p) => p.id === currentPage);
      const btns = page?.buttons || [];
      setButtons(btns);
      const newest =
        btns.find((b) => b.id === created?.id) ?? btns[btns.length - 1];
      if (newest) selectBtn(newest);
    },
    [currentPage, selectBtn, reloadPages, setButtons],
  );

  async function saveButton() {
    if (!resolvedSelected) return;
    setSaving(true);
    await fetch(`${api()}/buttons/${resolvedSelected}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(resolvedForm),
    });
    setSaving(false);
    setSaved(true);
    setSavedForm(resolvedForm);
    setTimeout(() => setSaved(false), 2000);
    const data = await reloadPages();
    const page = data.find((p) => p.id === currentPage);
    setButtons(page?.buttons || []);
    const updated = (page?.buttons || []).find(
      (b) => b.id === resolvedSelected,
    );
    if (updated) {
      setForm((f) => ({ ...f, icon_data: updated.icon_data }));
      setSavedForm((f) => (f ? { ...f, icon_data: updated.icon_data } : f));
    }
  }

  async function deleteButton() {
    if (!resolvedSelected) return;
    askConfirm("Delete this button?", async () => {
      await fetch(`${api()}/buttons/${resolvedSelected}`, { method: "DELETE" });
      setSelectedBtn(null);
      setForm({});
      const data = await reloadPages();
      const page = data.find((p) => p.id === currentPage);
      setButtons(page?.buttons ?? []);
    });
  }

  async function uploadIcon(file) {
    if (!resolvedSelected || !file) return;
    const buf = await file.arrayBuffer();
    const res = await fetch(`${api()}/buttons/${resolvedSelected}/icon`, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: buf,
    });
    const btn = await res.json();
    patchForm({ icon_data: btn.icon_data, icon: btn.icon });
    const data = await reloadPages();
    const page = data.find((p) => p.id === currentPage);
    setButtons(page?.buttons || []);
  }

  async function uploadSound(file) {
    if (!resolvedSelected || !file) return;
    const buf = await file.arrayBuffer();
    await fetch(`${api()}/buttons/${resolvedSelected}/sound`, {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: buf,
    });
    patchForm({ sound_file: true });
  }

  async function deleteSound() {
    if (!resolvedSelected) return;
    await fetch(`${api()}/buttons/${resolvedSelected}/sound`, {
      method: "DELETE",
    });
    patchForm({ sound_file: null });
  }

  async function toggleAutoSwitch(val) {
    setAutoSwitch(val);
    await fetch(`${api()}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "auto_profile_switching", value: val }),
    });
  }

  async function saveAudioSettings() {
    await fetch(`${api()}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "pc_sound_device", value: pcSoundDevice }),
    });
    await fetch(`${api()}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        key: "pc_monitor_device",
        value: pcMonitorDevice,
      }),
    });
    setAudioSettingsSaved(true);
    setTimeout(() => setAudioSettingsSaved(false), 2000);
  }

  async function disconnectDevice(clientId) {
    await fetch(`${api()}/clients/${clientId}`, { method: "DELETE" });
    setConnectedDevices((prev) => prev.filter((d) => d.id !== clientId));
  }

  // FEATURE: Pairing — unlike Disconnect, this drops the stored credential, so
  // the device cannot return without scanning a fresh QR code.
  async function revokeDevice(deviceId) {
    await fetch(`${api()}/paired-devices/${deviceId}`, { method: "DELETE" });
    setPairedDevices((prev) => prev.filter((d) => d.id !== deviceId));
    setConnectedDevices((prev) =>
      prev.filter((c) => c.pairedDeviceId !== deviceId),
    );
  }

  // ── Profile rule management ───────────────────────────────────────────────

  async function reloadProfileRules() {
    const res = await fetch(`${api()}/profile-rules`);
    const data = await res.json();
    setProfileRules(data);
    return data;
  }

  async function saveProfileRule(rulePatch) {
    if (!currentPage) return;
    const currentRule = profileRules.find((r) => r.page_id === currentPage);
    const nextRule = {
      page_id: currentPage,
      enabled: true,
      priority: 100,
      logic: "AND",
      conditions: [emptyCondition()],
      ...(currentRule || {}),
      ...rulePatch,
    };
    const endpoint = currentRule
      ? `${api()}/profile-rules/${currentRule.id}`
      : `${api()}/profile-rules`;
    const method = currentRule ? "PATCH" : "POST";
    await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextRule),
    });
    await reloadProfileRules();
  }

  async function deleteProfileRule() {
    const currentRule = profileRules.find((r) => r.page_id === currentPage);
    if (!currentRule) return;
    await fetch(`${api()}/profile-rules/${currentRule.id}`, {
      method: "DELETE",
    });
    await reloadProfileRules();
    setRuleEditorKey((k) => k + 1); // ← force editor remount with clean state
  }

  async function getCurrentApp() {
    try {
      const res = await fetch(`${api()}/active-window`);
      const data = await res.json();
      setActiveWindow(data);
      return data;
    } catch {
      return null;
    }
  }

  async function loadOpenWindows() {
    try {
      const res = await fetch(`${api()}/open-windows`);
      const data = await res.json();
      setOpenWindows(Array.isArray(data) ? data : []);
      setShowAppPicker(true);
    } catch {
      setOpenWindows([]);
      setShowAppPicker(true);
    }
  }

  async function saveAppAsRule(app) {
    await saveProfileRule({
      enabled: true,
      logic: "AND",
      conditions: [
        { type: "process", operator: "equals", value: app.process || "" },
      ],
    });
    setActiveWindow(app);
    setShowAppPicker(false);
  }

  function startDelayedCapture() {
    clearInterval(captureTimerRef.current);
    setCaptureCountdown(3);
    let remaining = 3;
    captureTimerRef.current = setInterval(async () => {
      remaining -= 1;
      setCaptureCountdown(remaining);
      if (remaining > 0) return;
      clearInterval(captureTimerRef.current);
      const app = await getCurrentApp();
      if (app) await saveAppAsRule(app);
    }, 1000);
  }

  // ── Drag and drop ─────────────────────────────────────────────────────────

  const handleDragStart = useCallback(({ active }) => {
    setActiveId(active.id);
  }, []);

  const handleDragEnd = useCallback(
    ({ active, over }) => {
      setActiveId(null);
      if (!over) return;

      // Library rows carry an `action:` prefix so they can be told apart from
      // keys, which are dragged for reordering.
      const dragged = String(active.id);
      if (dragged.startsWith("action:")) {
        const actionType = dragged.slice("action:".length);
        if (over.id === ADD_SLOT_ID) createWithAction(actionType);
        else assignAction(String(over.id), actionType);
        return;
      }

      if (active.id === over.id) return;
      setButtons((prev) => {
        const oldIndex = prev.findIndex((b) => b.id === active.id);
        const newIndex = prev.findIndex((b) => b.id === over.id);
        const reordered = arrayMove(prev, oldIndex, newIndex).map((btn, i) => ({
          ...btn,
          position: i,
        }));
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
    [wsRef, setButtons, assignAction, createWithAction],
  );

  // ── Derived ───────────────────────────────────────────────────────────────

  const isConnected = status === "connected";
  const selectedBtnData = buttons.find((b) => b.id === resolvedSelected);
  const buttonIds = buttons.map((b) => b.id);
  const activeBtn = buttons.find((b) => b.id === activeId);
  // A library row is being dragged rather than a key — used for the ghost.
  const activeAction = String(activeId ?? "").startsWith("action:")
    ? ACTION_BY_ID[String(activeId).slice("action:".length)]
    : null;
  const currentRule = profileRules.find((r) => r.page_id === currentPage);
  const phoneDevices = useMemo(
    () =>
      connectedDevices.filter(
        (d) =>
          d.ip !== "127.0.0.1" &&
          d.ip !== "::1" &&
          !d.ip?.startsWith("::ffff:127."),
      ),
    [connectedDevices],
  );

  // FEATURE: Pairing — one row per known device. A paired device shows even
  // while offline, so it can be revoked without waiting for it to reconnect.
  // Live sockets with no stored credential (paired before this existed) still
  // appear, so nothing silently vanishes from the list.
  const deviceRows = useMemo(() => {
    const rows = pairedDevices.map((device) => ({
      key: device.id,
      pairedId: device.id,
      // Stored name is the raw user-agent, so shorten it the same way the
      // live-socket rows do rather than printing the whole string.
      name: parseDeviceName(device.name),
      pairedAt: device.created_at,
      lastSeen: device.last_seen,
      session: phoneDevices.find((c) => c.pairedDeviceId === device.id) || null,
    }));

    const orphans = phoneDevices
      .filter((c) => !c.pairedDeviceId)
      .map((c) => ({
        key: c.id,
        pairedId: null,
        name: parseDeviceName(c.userAgent),
        pairedAt: null,
        lastSeen: null,
        session: c,
      }));

    return [...rows, ...orphans];
  }, [pairedDevices, phoneDevices]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.root}>
      <style>{globalStyles}</style>

      {/* ── Top bar ── */}
      <TopBar
        stats={stats}
        volume={volume}
        muted={muted}
        micVolume={micVolume}
        micMuted={micMuted}
        sessions={sessions}
        isConnected={isConnected}
        status={status}
        onPair={openPairQR}
        pairOpen={showQR}
        onDevices={() => setShowDevices(true)}
        devicesCount={phoneDevices.length}
        onAudioSettings={() => setShowAudioSettings(true)}
      />

      {/* ── Body ── */}
      <div style={styles.body}>
        {/* ── CANVAS COLUMN ── */}
        <DndContext
          sensors={sensors}
          collisionDetection={collisionDetection}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          <div style={styles.canvasCol}>
            <div style={styles.canvasHead}>
              <ProfileMenu
                open={profileMenuOpen}
                setOpen={setProfileMenuOpen}
                pages={pages}
                currentPage={currentPage}
                buttons={buttons}
                pageButtonCounts={pageButtonCounts}
                profileRules={profileRules}
                onSelectPage={(id) => {
                  switchPage(id);
                  setSelectedBtn(null);
                }}
                onAddPage={addPage}
                onDeletePage={deletePage}
                onOpenRules={() => setShowRules(true)}
                showLabels={showLabels}
                onToggleLabels={() => {
                  // No optimistic copy: the host broadcasts the change straight
                  // back over the socket it is already holding open, so every
                  // surface flips from the same message.
                  fetch(`${api()}/settings`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      key: "deck_show_labels",
                      value: !showLabels,
                    }),
                  }).catch(() => {});
                }}
                addingPage={addingPage}
                setAddingPage={setAddingPage}
                newPageName={newPageName}
                setNewPageName={setNewPageName}
              />
            </div>

            <SortableContext items={buttonIds} strategy={rectSortingStrategy}>
              <div style={styles.canvas} ref={canvasRef}>
                <div
                  style={{
                    ...styles.grid,
                    gridTemplateColumns: `repeat(${deckLayout.cols}, ${deckLayout.size}px)`,
                    gridAutoRows: `${deckLayout.size}px`,
                  }}
                >
                  {buttons.map((btn) => (
                    <DesktopSortableButton
                      key={btn.id}
                      btn={btn}
                      selected={resolvedSelected === btn.id}
                      volume={volume}
                      muted={muted}
                      micVolume={micVolume}
                      micMuted={micMuted}
                      sessions={sessions}
                      onSelect={selectBtn}
                      showLabels={showLabels}
                      droppingAction={!!activeAction}
                    />
                  ))}
                  {/* Empty well — click to add, or drop an action to create */}
                  <AddSlot onClick={addButton} />
                </div>
              </div>
            </SortableContext>

            {/* Drag overlay — floating ghost button while dragging */}
            <DragOverlay dropAnimation={{ duration: 180, easing: "ease" }}>
              {activeBtn ? (
                <ButtonTile
                  btn={activeBtn}
                  selected={false}
                  volume={volume}
                  muted={muted}
                  micVolume={micVolume}
                  micMuted={micMuted}
                  sessions={sessions}
                  ghost
                />
              ) : activeAction ? (
                <div style={styles.actionGhost}>
                  <ActionIcon name={activeAction.icon} size={15} />
                  {activeAction.name}
                </div>
              ) : null}
            </DragOverlay>

            <PageRail
              pages={pages}
              currentPage={currentPage}
              onSelectPage={(id) => {
                switchPage(id);
                setSelectedBtn(null);
              }}
              onAddPage={() => {
                setAddingPage(true);
                setProfileMenuOpen(true);
              }}
            />

            {/* ── Inspector: sits under the canvas, like the deck's own panel ── */}
            <PropertyPanel
              btn={selectedBtnData}
              form={resolvedForm}
              saving={saving}
              saved={saved}
              dirty={isDirty}
              audioDevices={audioDevices}
              inputDevices={inputDevices}
              audioSessions={audioSessions}
              onPatch={patchForm}
              onSave={saveButton}
              onRevert={revertForm}
              onDelete={deleteButton}
              onUploadIcon={uploadIcon}
              onUploadSound={uploadSound}
              onDeleteSound={deleteSound}
            />
          </div>

          <ActionLibrary />
        </DndContext>
      </div>
      {showQR && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.75)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowQR(false)}
        >
          <div
            style={{
              background: "#1e1e1e",
              border: "1px solid #303030",
              borderRadius: 20,
              padding: 32,
              textAlign: "center",
              minWidth: 300,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: "#3d8fd6",
                marginBottom: 4,
              }}
            >
              Connect Phone
            </div>
            <div style={{ fontSize: 11, color: "#555", marginBottom: 20 }}>
              Open EchoDeck on your phone and scan this QR code
            </div>
            {qrDataUrl && (
              <div
                style={{
                  background: "#0e0e0e",
                  borderRadius: 12,
                  padding: 12,
                  display: "inline-block",
                  marginBottom: 16,
                }}
              >
                <img
                  src={qrDataUrl}
                  width={220}
                  height={220}
                  alt="Pairing QR code"
                />
              </div>
            )}
            <div
              style={{
                fontSize: 10,
                color: "#444",
                wordBreak: "break-all",
                marginBottom: 16,
                padding: "0 8px",
              }}
            >
              {pairUrl}
            </div>
            <button
              onClick={() => setShowQR(false)}
              style={{
                width: "100%",
                padding: "10px 0",
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: 10,
                color: "#888",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* ── Devices Modal ── */}
      {showDevices && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowDevices(false)}
        >
          <div
            style={{
              background: "#1a1a1a",
              border: "1px solid #313131",
              borderRadius: 18,
              width: 420,
              maxWidth: "90vw",
              boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #252525",
                background: "#121212",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="phone" size={17} />
                <span
                  style={{ fontWeight: 700, fontSize: 14, color: "#e6e6e6" }}
                >
                  Paired Devices
                </span>
                <span
                  style={{
                    fontSize: 11,
                    background: "#222222",
                    border: "1px solid #323232",
                    borderRadius: 10,
                    padding: "1px 7px",
                    color: "#808080",
                  }}
                >
                  {phoneDevices.length} online
                </span>
              </div>
              <button
                onClick={() => setShowDevices(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#4f4f4f",
                  cursor: "pointer",
                  fontSize: 16,
                  padding: "2px 6px",
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <div
              style={{
                padding: "16px 20px 20px",
                maxHeight: 400,
                overflowY: "auto",
              }}
            >
              {deviceRows.length === 0 ? (
                <div
                  style={{
                    textAlign: "center",
                    padding: "32px 0",
                    color: "#4f4f4f",
                    fontSize: 13,
                  }}
                >
                  No devices paired yet
                </div>
              ) : (
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  {deviceRows.map((row) => {
                    const online = !!row.session;
                    const connectedAgo = row.session?.connectedAt
                      ? Math.floor(
                          (Date.now() - new Date(row.session.connectedAt)) /
                            60000,
                        )
                      : null;
                    return (
                      <div
                        key={row.key}
                        style={{
                          background: "#202020",
                          border: "1px solid #313131",
                          borderRadius: 12,
                          padding: "12px 14px",
                          display: "flex",
                          alignItems: "center",
                          gap: 12,
                          opacity: online ? 1 : 0.65,
                        }}
                      >
                        <div
                          style={{
                            flexShrink: 0,
                            color: "var(--text-secondary)",
                          }}
                        >
                          <Icon name="phone" size={22} />
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div
                            style={{
                              fontWeight: 700,
                              fontSize: 13,
                              color: "#cccccc",
                              marginBottom: 2,
                              display: "flex",
                              alignItems: "center",
                              gap: 6,
                            }}
                          >
                            <span
                              style={{
                                width: 6,
                                height: 6,
                                borderRadius: "50%",
                                flexShrink: 0,
                                background: online ? "#4ade80" : "#4f4f4f",
                                boxShadow: online ? "0 0 6px #4ade80" : "none",
                              }}
                            />
                            {online
                              ? `${row.name} — ${row.session.ip}`
                              : row.name}
                          </div>
                          <div style={{ fontSize: 11, color: "#4f4f4f" }}>
                            {online
                              ? `${
                                  connectedAgo === 0
                                    ? "Connected just now"
                                    : `Connected ${connectedAgo}m ago`
                                }${row.session.currentPage ? " · page active" : ""}`
                              : row.lastSeen
                                ? `Offline · last seen ${new Date(row.lastSeen).toLocaleString()}`
                                : row.pairedId
                                  ? "Offline · never connected"
                                  : "Connected"}
                          </div>
                        </div>
                        {online ? (
                          <button
                            onClick={() =>
                              askConfirm(
                                `Disconnect ${row.name}? It will reconnect on its own — use Revoke to remove it for good.`,
                                () => disconnectDevice(row.session.id),
                              )
                            }
                            style={{
                              background: "#1a1a1a",
                              border: "1px solid #313131",
                              borderRadius: 8,
                              color: "#909090",
                              cursor: "pointer",
                              fontSize: 11,
                              padding: "5px 10px",
                              fontWeight: 600,
                              flexShrink: 0,
                            }}
                          >
                            Disconnect
                          </button>
                        ) : null}
                        {row.pairedId ? (
                          <button
                            onClick={() =>
                              askConfirm(
                                `Revoke ${row.name}? It will need to scan a new QR code to connect again.`,
                                () => revokeDevice(row.pairedId),
                              )
                            }
                            style={{
                              background: "#2a1010",
                              border: "1px solid #4a1a1a",
                              borderRadius: 8,
                              color: "#f87171",
                              cursor: "pointer",
                              fontSize: 11,
                              padding: "5px 10px",
                              fontWeight: 600,
                              flexShrink: 0,
                            }}
                          >
                            Revoke
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
              <div
                style={{
                  marginTop: 14,
                  fontSize: 11,
                  color: "#353535",
                  textAlign: "center",
                }}
              >
                Disconnect ends the current session; the device reconnects on
                its own. Revoke removes its pairing entirely.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Audio Settings Modal ── */}
      {showAudioSettings && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.7)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
          onClick={() => setShowAudioSettings(false)}
        >
          <div
            style={{
              background: "#1a1a1a",
              border: "1px solid #313131",
              borderRadius: 18,
              width: 440,
              maxWidth: "90vw",
              boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
              overflow: "hidden",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #252525",
                background: "#121212",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Icon name="sound" size={17} />
                <span
                  style={{ fontWeight: 700, fontSize: 14, color: "#e6e6e6" }}
                >
                  Audio Settings
                </span>
              </div>
              <button
                onClick={() => setShowAudioSettings(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#4f4f4f",
                  cursor: "pointer",
                  fontSize: 16,
                  padding: "2px 6px",
                }}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <div style={{ padding: "20px 20px 24px" }}>
              <div
                style={{
                  background: "#1a0a2e",
                  border: "1px solid #3b1a5c",
                  borderRadius: 12,
                  padding: 16,
                  marginBottom: 16,
                }}
              >
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: "#c084fc",
                    marginBottom: 6,
                  }}
                >
                  PC Soundboard Output Device
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#6b3fa0",
                    marginBottom: 12,
                    lineHeight: 1.6,
                  }}
                >
                  Where PC sounds play. Pick your speakers to hear them
                  yourself, or a virtual cable such as{" "}
                  <strong style={{ color: "#a855f7" }}>VB-CABLE</strong> (set as
                  Discord&apos;s input) so a call hears them too.
                </div>
                <select
                  value={pcSoundDevice}
                  onChange={(e) => setPcSoundDevice(e.target.value)}
                  style={{
                    width: "100%",
                    background: "#141414",
                    border: "1px solid #3b1a5c",
                    borderRadius: 8,
                    color: "#e6e6e6",
                    padding: "8px 10px",
                    fontSize: 12,
                    marginBottom: 12,
                    boxSizing: "border-box",
                    outline: "none",
                  }}
                >
                  <option value="">System default</option>
                  {/* Keep a saved-but-missing device selectable so upgrading
                      from the old free-text field never silently drops it. */}
                  {pcSoundDevice && !outputDevices.includes(pcSoundDevice) ? (
                    <option value={pcSoundDevice}>
                      {pcSoundDevice} (not found — using default)
                    </option>
                  ) : null}
                  {outputDevices.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>

                {/* FEATURE: Soundboard — monitor output. Routing sounds into a
                    virtual cable means you stop hearing them yourself; this
                    plays them on a second device at the same time. */}
                <div
                  style={{
                    fontSize: 11,
                    color: "#6b3fa0",
                    marginBottom: 6,
                    lineHeight: 1.6,
                  }}
                >
                  Also play on{" "}
                  <strong style={{ color: "#a855f7" }}>monitor</strong> — pick
                  your headset here when the output above is a virtual cable, so
                  you hear the sound too.
                </div>
                <select
                  value={pcMonitorDevice}
                  onChange={(e) => setPcMonitorDevice(e.target.value)}
                  style={{
                    width: "100%",
                    background: "#141414",
                    border: "1px solid #3b1a5c",
                    borderRadius: 8,
                    color: "#e6e6e6",
                    padding: "8px 10px",
                    fontSize: 12,
                    marginBottom: 12,
                    boxSizing: "border-box",
                    outline: "none",
                  }}
                >
                  <option value="">Off — don&apos;t monitor</option>
                  {pcMonitorDevice &&
                  !outputDevices.includes(pcMonitorDevice) ? (
                    <option value={pcMonitorDevice}>
                      {pcMonitorDevice} (not found)
                    </option>
                  ) : null}
                  {outputDevices.map((label) => (
                    <option key={label} value={label}>
                      {label}
                    </option>
                  ))}
                </select>
                <button
                  onClick={saveAudioSettings}
                  style={{
                    width: "100%",
                    padding: "8px 0",
                    borderRadius: 8,
                    fontSize: 12,
                    fontWeight: 700,
                    background: audioSettingsSaved
                      ? "linear-gradient(135deg,#1a4a2a,#1a5c34)"
                      : "linear-gradient(135deg,#3d8fd6,#9333ea)",
                    border: "none",
                    color: audioSettingsSaved ? "#34d399" : "#fff",
                    cursor: "pointer",
                  }}
                >
                  {audioSettingsSaved ? "Saved" : "Save"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showRules && currentPage && (
        <RuleEditorModal
          key={`${currentPage}-${ruleEditorKey}`}
          pageName={pages.find((p) => p.id === currentPage)?.name || ""}
          rule={currentRule}
          enabled={autoSwitch}
          activeWindow={activeWindow}
          openWindows={openWindows}
          showAppPicker={showAppPicker}
          captureCountdown={captureCountdown}
          onClose={() => setShowRules(false)}
          onToggleGlobal={toggleAutoSwitch}
          onSave={saveProfileRule}
          onDelete={deleteProfileRule}
          onSelectRunningApp={loadOpenWindows}
          onPickApp={saveAppAsRule}
          onClosePicker={() => setShowAppPicker(false)}
          onCaptureDelayed={startDelayedCapture}
          onRefreshCurrentApp={getCurrentApp}
        />
      )}

      {confirmModal && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={() => setConfirmModal(null)}
        >
          <div
            style={{
              background: "#1c1c1c",
              border: "1px solid #303030",
              borderRadius: 14,
              padding: "24px 28px",
              minWidth: 300,
              boxShadow: "0 20px 60px rgba(0,0,0,0.6)",
              animation: "fadeIn 0.15s ease",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <p
              style={{
                fontSize: 14,
                color: "#ccc",
                marginBottom: 20,
                lineHeight: 1.5,
              }}
            >
              {confirmModal.message}
            </p>
            <div
              style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}
            >
              <button
                onClick={() => setConfirmModal(null)}
                style={{
                  padding: "7px 18px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  background: "#232323",
                  border: "1px solid #303030",
                  color: "#888",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                style={{
                  padding: "7px 18px",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 700,
                  cursor: "pointer",
                  ...(confirmModal.tone === "neutral"
                    ? {
                        background: "var(--bg-hover)",
                        border: "1px solid var(--border-strong)",
                        color: "var(--text-primary)",
                      }
                    : {
                        background: "#2e0d0d",
                        border: "1px solid #5c1a1a",
                        color: "#f87171",
                      }),
                }}
              >
                {confirmModal.confirmLabel ?? "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Top Bar ──────────────────────────────────────────────────────────────────

function TopBar({
  stats,
  volume,
  muted,
  isConnected,
  status,
  onPair,
  pairOpen,
  onDevices,
  devicesCount,
  onAudioSettings,
}) {
  return (
    <div style={styles.topBar}>
      <div style={styles.topBarLogo}>
        <img
          src={deckIcon}
          alt="EchoDeck"
          draggable={false}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            display: "block",
            flexShrink: 0,
          }}
        />
        <span style={styles.logoText}>EchoDeck</span>
        <div style={styles.logoDivider} />
      </div>

      <div style={styles.topBarStats}>
        {stats && (
          <>
            <StatChip
              label="CPU"
              value={`${stats.cpu}%`}
              warn={stats.cpu > 80}
            />
            <StatChip
              label="RAM"
              value={`${stats.ramUsed}/${stats.ramTotal}G`}
              warn={stats.ramUsed / stats.ramTotal > 0.85}
            />
            <StatChip value={stats.time} />
          </>
        )}
        {volume !== null && <VolChip volume={volume} muted={muted} />}
      </div>

      <div style={styles.topBarRight}>
        {/* Devices button — shows count of connected phones */}
        <button
          onClick={onDevices}
          style={{
            ...styles.topBarBtn,
            ...(devicesCount > 0
              ? { borderColor: "rgba(52,211,153,0.3)", color: "#34d399" }
              : {}),
          }}
          title="Connected devices"
        >
          <Icon name="phone" size={15} />
          <span>Devices{devicesCount > 0 ? ` (${devicesCount})` : ""}</span>
        </button>

        {/* Audio settings */}
        <button
          onClick={onAudioSettings}
          style={styles.topBarBtn}
          title="Audio settings"
        >
          <Icon name="sound" size={15} />
          <span>Audio</span>
        </button>

        {/* QR pair */}
        <button
          onClick={onPair}
          style={{
            ...styles.topBarBtn,
            ...(pairOpen ? styles.topBarBtnActive : {}),
          }}
        >
          <Icon name="add" size={15} />
          <span>{pairOpen ? "QR Open" : "Add Phone"}</span>
        </button>

        <div
          style={{
            ...styles.connBadge,
            ...(isConnected
              ? styles.connOn
              : status === "connecting"
                ? styles.connWarn
                : styles.connOff),
          }}
        >
          <span
            style={{
              ...styles.connDot,
              background: isConnected
                ? "#34d399"
                : status === "connecting"
                  ? "#fb923c"
                  : "#f87171",
              boxShadow: isConnected
                ? "0 0 5px #34d39988"
                : status === "connecting"
                  ? "0 0 5px #fb923c88"
                  : "0 0 5px #f8717188",
            }}
          />
          {isConnected
            ? "Connected"
            : status === "connecting"
              ? "Connecting…"
              : "Offline"}
        </div>
      </div>
    </div>
  );
}

function StatChip({ label, value, warn }) {
  return (
    <div style={{ ...styles.chip, ...(warn ? styles.chipWarn : {}) }}>
      {label && (
        <span
          style={{
            color: warn ? "#fb923c66" : "#494949",
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {label}
        </span>
      )}
      <span
        style={{
          color: warn ? "#fb923c" : "#828282",
          fontSize: 11,
          fontWeight: 500,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </span>
    </div>
  );
}

function VolChip({ volume, muted }) {
  return (
    <div
      style={{
        ...styles.chip,
        ...(muted
          ? { background: "#2e0d0d", border: "1px solid #5c1a1a" }
          : {}),
      }}
    >
      {/* No text wrapper: an inline SVG inside a span sits on that span's
          baseline, which pushed the speaker glyph below the centre line of the
          bar and the percentage next to it. */}
      <Icon
        name="sound"
        size={13}
        style={{ display: "block", flexShrink: 0 }}
      />
      <div
        style={{
          width: 28,
          height: 3,
          background: "#222",
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
            transition: "transform 0.15s",
          }}
        />
      </div>
      <span
        style={{
          color: muted ? "#f87171" : "#777",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {muted ? "—" : `${volume}%`}
      </span>
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

/**
 * The profile switcher, replacing the old left sidebar. Switching is the common
 * action so it sits one click away; creating, deleting and auto-switch rules are
 * occasional, so they live at the bottom of the menu rather than on screen.
 */
/** Drop target id for the empty well at the end of the deck. */
const ADD_SLOT_ID = "__add_slot__";

/** The empty well: click to add a blank key, or drop an action to create one. */
function AddSlot({ onClick }) {
  const { setNodeRef, isOver } = useDroppable({ id: ADD_SLOT_ID });
  return (
    <button
      ref={setNodeRef}
      style={{
        ...styles.addSlot,
        ...(isOver ? styles.addSlotOver : {}),
      }}
      onClick={onClick}
      aria-label="Add a key"
    >
      <Icon name="add" size={20} />
    </button>
  );
}

/** One draggable row in the library. */
// Memoised: one row per action, each holding a dnd-kit draggable. Without this
// all of them re-render on every keystroke in the property drawer.
const ActionRow = memo(function ActionRow({ action }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `action:${action.id}`,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{
        ...styles.actionRow,
        ...(isDragging ? styles.actionRowDragging : {}),
      }}
      title={action.name}
    >
      <ActionIcon name={action.icon} size={15} />
      <span style={styles.actionRowName}>{action.name}</span>
      <span style={styles.actionRowGrip}>
        <Icon name="drag" size={13} />
      </span>
    </div>
  );
});

/**
 * The actions library. Search filters across action and category names; each
 * category collapses so a long list stays navigable. Searching expands
 * everything that matched, because a hit hidden inside a collapsed group reads
 * as no result at all.
 */
// Takes no props at all, so memo pins it to a single render. It was rebuilding
// its whole list — every category and every draggable row — each time an
// unrelated piece of DesktopApp state changed.
const ActionLibrary = memo(function ActionLibrary() {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(() => new Set());

  const q = query.trim().toLowerCase();
  const groups = ACTION_CATEGORIES.map((cat) => ({
    label: cat.label,
    actions: q
      ? cat.actions.filter(
          (a) =>
            a.name.toLowerCase().includes(q) ||
            cat.label.toLowerCase().includes(q),
        )
      : cat.actions,
  })).filter((g) => g.actions.length > 0);

  const total = groups.reduce((n, g) => n + g.actions.length, 0);

  return (
    <aside style={styles.library} aria-label="Actions library">
      <div style={styles.libraryHead}>
        <div style={styles.searchWrap}>
          <span style={styles.searchIcon}>
            <Icon name="search" size={14} />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search actions"
            aria-label="Search actions"
            style={styles.searchInput}
          />
          {query ? (
            <button
              style={styles.searchClear}
              onClick={() => setQuery("")}
              aria-label="Clear search"
            >
              <Icon name="close" size={13} />
            </button>
          ) : null}
        </div>
      </div>

      <div style={styles.libraryList}>
        {total === 0 ? (
          <div style={styles.libraryEmpty}>No actions match “{query}”</div>
        ) : (
          groups.map((group) => {
            const isOpen = q ? true : !collapsed.has(group.label);
            return (
              <div key={group.label}>
                <button
                  style={styles.catHead}
                  aria-expanded={isOpen}
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = new Set(prev);
                      if (next.has(group.label)) next.delete(group.label);
                      else next.add(group.label);
                      return next;
                    })
                  }
                >
                  <span
                    style={{
                      ...styles.catChevron,
                      transform: isOpen ? "rotate(90deg)" : "none",
                    }}
                  >
                    <Icon name="chevronRight" size={13} />
                  </span>
                  <span style={styles.catName}>{group.label}</span>
                  <span style={styles.catCount}>{group.actions.length}</span>
                </button>

                {isOpen ? (
                  <div style={styles.catItems}>
                    {group.actions.map((action) => (
                      <ActionRow key={action.id} action={action} />
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>

      <div style={styles.libraryHint}>
        Drag an action onto a key, or onto the empty well to make a new one.
      </div>
    </aside>
  );
});

function ProfileMenu({
  open,
  setOpen,
  pages,
  currentPage,
  buttons,
  pageButtonCounts,
  profileRules,
  onSelectPage,
  onAddPage,
  onDeletePage,
  onOpenRules,
  showLabels,
  onToggleLabels,
  addingPage,
  setAddingPage,
  newPageName,
  setNewPageName,
}) {
  const wrapRef = useRef(null);
  const inputRef = useRef(null);
  const current = pages.find((p) => p.id === currentPage);
  const rule = profileRules.find((r) => r.page_id === currentPage);

  // Clicking away or pressing Escape closes the menu — a dropdown that can only
  // be dismissed by re-clicking its trigger feels stuck.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen]);

  useEffect(() => {
    if (addingPage) setTimeout(() => inputRef.current?.focus(), 50);
  }, [addingPage]);

  return (
    <div style={styles.profileWrap} ref={wrapRef}>
      <button
        style={styles.profileTrigger}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span style={styles.profileName}>{current?.name || "—"}</span>
        <Icon name="chevronDown" size={16} />
      </button>

      <div style={styles.profileMeta}>
        {buttons.length} button{buttons.length === 1 ? "" : "s"}
        {rule?.enabled && rule.conditions?.[0]?.value
          ? ` · auto-switches on ${rule.conditions[0].value}`
          : ""}
      </div>

      {open && (
        <div style={styles.menu} role="menu">
          <div style={styles.menuLabel}>Profiles</div>

          {pages.map((p) => {
            const isActive = p.id === currentPage;
            const pRule = profileRules.find((r) => r.page_id === p.id);
            return (
              <div
                key={p.id}
                role="menuitem"
                tabIndex={0}
                style={{
                  ...styles.menuItem,
                  ...(isActive ? styles.menuItemActive : {}),
                }}
                onClick={() => {
                  onSelectPage(p.id);
                  setOpen(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelectPage(p.id);
                    setOpen(false);
                  }
                }}
              >
                <span style={styles.menuCheck}>
                  {isActive ? <Icon name="check" size={14} /> : null}
                </span>
                <span style={styles.menuItemName}>{p.name}</span>
                {pRule?.enabled && pRule.conditions?.[0]?.value ? (
                  <span
                    style={styles.menuRuleDot}
                    title="Auto-switch rule set"
                  />
                ) : null}
                <span style={styles.menuCount}>
                  {isActive ? buttons.length : (pageButtonCounts[p.id] ?? 0)}
                </span>
                {pages.length > 1 && (
                  <button
                    style={styles.menuDelete}
                    aria-label={`Delete ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeletePage(p.id);
                    }}
                  >
                    <Icon name="close" size={13} />
                  </button>
                )}
              </div>
            );
          })}

          <div style={styles.menuDivider} />

          {addingPage ? (
            <div style={styles.menuAddRow}>
              <input
                ref={inputRef}
                value={newPageName}
                onChange={(e) => setNewPageName(e.target.value)}
                placeholder="Profile name…"
                style={styles.menuInput}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onAddPage();
                    setOpen(false);
                  }
                  if (e.key === "Escape") {
                    setAddingPage(false);
                    setNewPageName("");
                  }
                }}
              />
              <button
                style={styles.menuPrimary}
                onClick={() => {
                  onAddPage();
                  setOpen(false);
                }}
                disabled={!newPageName.trim()}
              >
                Add
              </button>
            </div>
          ) : (
            <button
              style={styles.menuAction}
              onClick={() => setAddingPage(true)}
            >
              <Icon name="add" size={14} />
              New profile
            </button>
          )}

          <button
            style={styles.menuAction}
            onClick={onToggleLabels}
            role="menuitemcheckbox"
            aria-checked={showLabels}
          >
            {/* The check keeps its slot when unchecked, so the row does not
                shift as it toggles. */}
            <span style={{ opacity: showLabels ? 1 : 0, display: "flex" }}>
              <Icon name="check" size={14} />
            </span>
            Key labels
          </button>

          <button
            style={styles.menuAction}
            onClick={() => {
              onOpenRules();
              setOpen(false);
            }}
          >
            <Icon name="settings" size={14} />
            Auto-switch rules…
          </button>
        </div>
      )}
    </div>
  );
}

/** Profile pills under the canvas — the fast switch, mirroring a deck's pages. */
const PageRail = memo(function PageRail({
  pages,
  currentPage,
  onSelectPage,
  onAddPage,
}) {
  return (
    <div style={styles.pageRail}>
      {pages.map((p, i) => (
        <button
          key={p.id}
          style={{
            ...styles.pagePill,
            ...(p.id === currentPage ? styles.pagePillActive : {}),
          }}
          onClick={() => onSelectPage(p.id)}
          aria-current={p.id === currentPage}
          title={p.name}
        >
          {i + 1}
        </button>
      ))}
      <button
        style={styles.pagePill}
        onClick={onAddPage}
        aria-label="New profile"
      >
        <Icon name="add" size={13} />
      </button>
    </div>
  );
});

/**
 * Auto-switch rules in a modal. The editor itself is unchanged — only where it
 * lives moved, so it no longer costs the canvas a 320px column.
 */
function RuleEditorModal({ pageName, onClose, ...editorProps }) {
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div style={styles.modalBackdrop} onClick={onClose}>
      <div
        style={styles.modalCard}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={`Auto-switch rules for ${pageName}`}
      >
        <div style={styles.modalHead}>
          <div>
            <div style={styles.modalTitle}>Auto-switch rules</div>
            <div style={styles.modalSub}>{pageName}</div>
          </div>
          <button style={styles.iconBtn} onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div style={styles.modalBody}>
          <AutoSwitchRuleEditor {...editorProps} />
        </div>
      </div>
    </div>
  );
}

function Toggle({ value, onChange }) {
  return (
    <div
      style={{
        width: 34,
        height: 19,
        borderRadius: 10,
        background: value ? "#3d8fd6" : "#2b2b2b",
        position: "relative",
        cursor: "pointer",
        transition: "background 0.18s",
        flexShrink: 0,
        border: `1px solid ${value ? "#3d8fd6" : "#333333"}`,
      }}
      onClick={() => onChange(!value)}
    >
      <div
        style={{
          width: 13,
          height: 13,
          borderRadius: "50%",
          background: "#fff",
          position: "absolute",
          top: 2,
          left: value ? 17 : 2,
          transition: "left 0.18s",
          boxShadow: "0 1px 3px rgba(0,0,0,0.5)",
        }}
      />
    </div>
  );
}

// ─── Auto-Switch Rule Editor ──────────────────────────────────────────────────

function AutoSwitchRuleEditor({
  rule,
  enabled,
  activeWindow,
  openWindows,
  showAppPicker,
  captureCountdown,
  onToggleGlobal,
  onSave,
  onDelete,
  onSelectRunningApp,
  onPickApp,
  onClosePicker,
  onCaptureDelayed,
  onRefreshCurrentApp,
}) {
  const emptyDraft = () => ({
    enabled: false,
    priority: 100,
    logic: "AND",
    switch_delay: 0,
    conditions: [emptyCondition()],
  });

  // ── Local draft — edits live here, not in the DB until Save is clicked ──
  const [localDraft, setLocalDraft] = useState(() => rule || emptyDraft());
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  // Which condition index triggered the app picker (-1 = whole-rule quick-set)
  const [pickerConditionIndex, setPickerConditionIndex] = useState(-1);

  // Sync from parent when the rule prop changes from outside
  // (page switch, initial load, picker writing a new rule)
  // but NOT when we're mid-edit (dirty=true)
  // useEffect(() => {
  //   if (!dirty) {
  //     setLocalDraft(rule || emptyDraft());
  //   }
  //   // eslint-disable-next-line react-hooks/exhaustive-deps
  // }, [rule]);

  const conditions = localDraft.conditions?.length
    ? localDraft.conditions
    : [emptyCondition()];

  function patchDraft(patch) {
    setLocalDraft((d) => ({ ...d, ...patch }));
    setDirty(true);
  }

  function patchCondition(index, patch) {
    patchDraft({
      conditions: conditions.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    });
  }

  async function handleSave() {
    setSaving(true);
    await onSave(localDraft);
    setSaving(false);
    setDirty(false);
  }

  const rs = ruleStyles;

  return (
    <div style={rs.panel}>
      {/* Header */}
      <div style={rs.header}>
        <div>
          <div style={rs.title}>Auto-switch</div>
          <div style={rs.meta}>
            {activeWindow?.process
              ? `${activeWindow.process}${activeWindow.windowTitle ? ` · ${activeWindow.windowTitle}` : ""}`
              : "No active app captured yet"}
          </div>
        </div>
        <label style={rs.enabledRow}>
          <Toggle value={enabled} onChange={onToggleGlobal} />
          <span
            style={{ fontSize: 11, color: enabled ? "#3d8fd6" : "#454545" }}
          >
            {enabled ? "On" : "Off"}
          </span>
        </label>
      </div>

      {/* Quick-capture buttons */}
      <div style={rs.actions}>
        <button
          style={rs.smallBtn}
          onClick={onSelectRunningApp}
          title="Pick from running apps"
        >
          Select app
        </button>
        <button
          style={rs.smallBtn}
          onClick={onCaptureDelayed}
          disabled={captureCountdown > 0}
          title="Switch to your target app, then it captures automatically"
        >
          {captureCountdown > 0 ? `${captureCountdown}s…` : "Capture 3s"}
        </button>
        <button
          style={rs.smallBtn}
          onClick={onRefreshCurrentApp}
          title="Refresh active window"
        >
          Refresh
        </button>
        {rule && (
          <button style={rs.dangerBtn} onClick={onDelete}>
            Remove
          </button>
        )}
      </div>

      {/* Rule settings row */}
      <div style={rs.settingsRow}>
        <label style={rs.miniLabel}>Rule</label>
        <input
          type="checkbox"
          checked={!!localDraft.enabled}
          onChange={(e) => patchDraft({ enabled: e.target.checked })}
          style={{ cursor: "pointer" }}
        />
        <label style={rs.miniLabel}>Logic</label>
        <select
          style={rs.compactSelect}
          value={localDraft.logic || "AND"}
          onChange={(e) => patchDraft({ logic: e.target.value })}
        >
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>
        <label style={rs.miniLabel}>Priority</label>
        <input
          type="number"
          min="0"
          max="1000"
          style={rs.compactInput}
          value={localDraft.priority ?? 100}
          onChange={(e) =>
            patchDraft({ priority: Number(e.target.value) || 0 })
          }
        />
      </div>

      {/* Switch delay slider */}
      <div style={rs.delayRow}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 5,
          }}
        >
          <span style={rs.miniLabel}>⏱ Switch delay</span>
          <span style={{ fontSize: 11, fontWeight: 700, color: "#3d8fd6" }}>
            {(localDraft.switch_delay ?? 0) === 0
              ? "Instant"
              : `${(localDraft.switch_delay ?? 0) / 1000}s`}
          </span>
        </div>
        <input
          type="range"
          min="0"
          max="5000"
          step="500"
          value={localDraft.switch_delay ?? 0}
          onChange={(e) => patchDraft({ switch_delay: Number(e.target.value) })}
          style={{ width: "100%", accentColor: "#3d8fd6", cursor: "pointer" }}
        />
        <div style={{ fontSize: 10, color: "#3b3b3b", marginTop: 3 }}>
          Waits before switching — prevents flicker when alt-tabbing.
        </div>
      </div>

      {/* Conditions */}

      {conditions.map((cond, index) => (
        <div key={index} style={rs.conditionRow}>
          <select
            style={rs.condSelect}
            value={cond.type}
            onChange={(e) => patchCondition(index, { type: e.target.value })}
          >
            {CONDITION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
          <select
            style={rs.condSelect}
            value={cond.operator}
            onChange={(e) =>
              patchCondition(index, { operator: e.target.value })
            }
          >
            {CONDITION_OPERATORS.map((op) => (
              <option key={op.value} value={op.value}>
                {op.label}
              </option>
            ))}
          </select>
          <input
            style={rs.condInput}
            value={cond.value || ""}
            disabled={cond.operator === "exists"}
            placeholder={
              cond.type === "process"
                ? "App.exe"
                : cond.type === "window_title"
                  ? "workspace"
                  : "C:\\Path\\App.exe"
            }
            onChange={(e) => patchCondition(index, { value: e.target.value })}
          />
          {/* Per-condition app picker button */}
          <button
            style={{ ...rs.removeCondBtn, color: "#3d8fd6", fontSize: 12 }}
            title="Pick from running apps"
            onClick={() => {
              setPickerConditionIndex(index);
              onSelectRunningApp();
            }}
          >
            ⊞
          </button>
          <button
            style={rs.removeCondBtn}
            onClick={() =>
              patchDraft({
                conditions: conditions.filter((_, i) => i !== index),
              })
            }
            disabled={conditions.length === 1}
            title="Remove condition"
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ))}

      <button
        style={rs.addCondBtn}
        onClick={() =>
          patchDraft({ conditions: [...conditions, emptyCondition()] })
        }
      >
        + Add condition
      </button>

      {/* Save button — only shown when there are unsaved changes */}
      {dirty && (
        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            width: "100%",
            padding: "7px 0",
            borderRadius: 7,
            fontSize: 11,
            fontWeight: 700,
            background: saving
              ? "#242424"
              : "linear-gradient(135deg,#3d8fd6,#3d8fd6)",
            border: "none",
            color: saving ? "#4f4f4f" : "#fff",
            cursor: saving ? "default" : "pointer",
          }}
        >
          {saving ? "Saving…" : "Save rule"}
        </button>
      )}

      {/* App picker dropdown */}
      {showAppPicker && (
        <div style={rs.picker}>
          <div style={rs.pickerHeader}>
            <span>Running apps</span>
            <button style={rs.pickerClose} onClick={onClosePicker}>
              <Icon name="close" size={14} />
            </button>
          </div>
          <div style={rs.pickerList}>
            {openWindows.length === 0 && (
              <div style={rs.pickerEmpty}>No visible windows found.</div>
            )}
            {openWindows.map((app, i) => (
              <button
                key={`${app.pid}-${i}`}
                style={rs.pickerItem}
                onClick={() => {
                  if (pickerConditionIndex >= 0) {
                    // Update only the specific condition that triggered the picker
                    patchCondition(pickerConditionIndex, {
                      type: "process",
                      operator: "equals",
                      value: app.process || "",
                    });
                    setPickerConditionIndex(-1);
                    onClosePicker();
                  } else {
                    // Whole-rule quick-set (triggered by top "Select app" button)
                    onPickApp(app);
                  }
                }}
              >
                <span style={rs.pickerProcess}>{app.process}</span>
                <span style={rs.pickerTitle}>{app.windowTitle}</span>
                <span style={rs.pickerPath}>{app.executablePath || "—"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Desktop Sortable Button ──────────────────────────────────────────────────

const DesktopSortableButton = memo(function DesktopSortableButton({
  btn,
  selected,
  volume,
  muted,
  micVolume,
  micMuted,
  sessions,
  onSelect,
  showLabels,
  droppingAction,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
    isOver,
  } = useSortable({ id: btn.id });

  // Only light up while an action is being dragged — during a reorder every
  // key passes under the cursor and flashing them all would be noise.
  const isDropTarget = isOver && droppingAction;

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        zIndex: isDragging ? 999 : "auto",
        opacity: isDragging ? 0.3 : 1,
        borderRadius: 8,
        // Longhands, not the `outline` shorthand: a var() inside a shorthand set
        // through inline styles becomes a pending-substitution value and
        // computes to transparent, so the highlight never painted.
        outlineStyle: "solid",
        outlineWidth: 2,
        outlineColor: isDropTarget ? "var(--accent)" : "transparent",
        outlineOffset: 2,
        boxShadow: isDropTarget ? "0 0 0 6px rgba(59,130,246,0.20)" : "none",
        transition: [
          transition,
          "outline-color 140ms var(--ease-out)",
          "box-shadow 140ms var(--ease-out)",
        ]
          .filter(Boolean)
          .join(", "),
        ...(btn.size === "2x2"
          ? { gridColumn: "span 2", gridRow: "span 2" }
          : {}),
      }}
      onClick={(e) => {
        if (!isDragging) {
          e.stopPropagation();
          onSelect(btn);
        }
      }}
    >
      <ButtonTile
        btn={btn}
        selected={selected}
        volume={volume}
        muted={muted}
        micVolume={micVolume}
        micMuted={micMuted}
        sessions={sessions}
        showLabels={showLabels}
      />
    </div>
  );
});

function ButtonTile({
  btn,
  selected,
  volume,
  muted,
  micVolume,
  micMuted,
  sessions,
  ghost,
  showLabels = true,
}) {
  const isToggleOn =
    Number(btn.is_toggle) === 1 && Number(btn.toggle_state) === 1;
  const isToggle = Number(btn.is_toggle) === 1;
  const levelTarget = levelTargetFor(btn.action_type);
  const isVolumeBtn = levelTarget !== null;
  // An app key reads the level of whichever application it targets, so a change
  // to a silent app is still visible on the face.
  const appSession =
    levelTarget === "app"
      ? (sessions || []).find(
          (s) =>
            s.app.toLowerCase() ===
            unpackAppValue(btn.action_value).app.toLowerCase(),
        )
      : null;
  const level =
    levelTarget === "app"
      ? (appSession?.volume ?? null)
      : levelTarget === "mic"
        ? micVolume
        : volume;
  const levelMuted =
    levelTarget === "app"
      ? !!appSession?.muted
      : levelTarget === "mic"
        ? micMuted
        : muted;
  const isVideo = btn.icon_data?.startsWith("data:video/");

  const accentColor = btn.color || "#3d8fd6";

  return (
    <div
      style={{
        aspectRatio: "1/1",
        borderRadius: 8,
        cursor: "pointer",
        position: "relative",
        overflow: "hidden",
        userSelect: "none",
        // Elgato-style: dark base with subtle top highlight
        background: isToggleOn
          ? `linear-gradient(160deg, ${accentColor}38 0%, ${accentColor}18 100%)`
          : selected
            ? "linear-gradient(160deg, #313131 0%, #212121 100%)"
            : "linear-gradient(160deg, #2a2a2a 0%, #1c1c1c 100%)",
        border: selected
          ? `1.5px solid #3d8fd6`
          : isToggleOn
            ? `1.5px solid ${accentColor}70`
            : "1.5px solid #333333",
        boxShadow: selected
          ? `0 0 0 3px rgba(79,128,255,0.2), 0 4px 16px rgba(0,0,0,0.5)`
          : isToggleOn
            ? `0 0 12px ${accentColor}40, 0 4px 12px rgba(0,0,0,0.4)`
            : "0 2px 8px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.06)",
        opacity: ghost ? 0.7 : 1,
        transition: "border 0.12s, box-shadow 0.12s, background 0.12s",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {/* Subtle top highlight line (Elgato key feel) */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: 1,
          background: "rgba(255,255,255,0.07)",
          borderRadius: "8px 8px 0 0",
          pointerEvents: "none",
          zIndex: 4,
        }}
      />

      {/* Color accent bar at bottom */}
      <div
        style={{
          position: "absolute",
          bottom: 0,
          left: 0,
          right: 0,
          height: 3,
          background: isToggleOn ? accentColor : `${accentColor}55`,
          borderRadius: "0 0 12px 12px",
          pointerEvents: "none",
          zIndex: 4,
          transition: "background 0.15s",
        }}
      />

      {/* Toggle indicator dot */}
      {isToggle && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            width: 5,
            height: 5,
            borderRadius: "50%",
            background: isToggleOn ? accentColor : "rgba(255,255,255,0.12)",
            boxShadow: isToggleOn ? `0 0 5px ${accentColor}` : "none",
            animation: isToggleOn
              ? "toggleGlow 2s ease-in-out infinite"
              : "none",
            zIndex: 3,
          }}
        />
      )}

      {/* Sound indicator */}
      {btn.sound_file && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            left: 7,
            fontSize: 8,
            opacity: 0.45,
            zIndex: 3,
          }}
        >
          <Icon name="sound" size={9} />
        </div>
      )}

      {/* FEATURE: Hold to confirm — mirrors the phone's guard badge so you can
          see which buttons are protected while laying out the deck. */}
      {Number(btn.require_confirm) === 1 && (
        <div
          style={{
            position: "absolute",
            bottom: 8,
            right: 7,
            fontSize: 8,
            opacity: 0.45,
            zIndex: 3,
          }}
        >
          <Icon name="guarded" size={9} />
        </div>
      )}

      {/* Icon */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          display: "flex",
          alignItems: showLabels ? "center" : "center",
          justifyContent: "center",
          paddingBottom: showLabels ? 14 : 0,
          borderRadius: 8,
          overflow: "hidden",
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
              width: "68%",
              height: "68%",
              objectFit: "contain",
              borderRadius: 8,
            }}
          />
        ) : btn.icon_data ? (
          <img
            src={btn.icon_data}
            draggable={false}
            style={{
              width: "68%",
              height: "68%",
              objectFit: "contain",
              borderRadius: 8,
            }}
          />
        ) : (
          <ButtonFace
            icon={btn.icon}
            size={btn.size === "2x2" ? 48 : 32}
            style={{
              fontSize:
                btn.size === "2x2" ? "min(48px,5.5vw)" : "min(34px,3.5vw)",
            }}
          />
        )}
      </div>

      {/* Volume fill */}
      {isVolumeBtn && level !== null && (
        <div
          style={{
            position: "absolute",
            left: 9,
            right: 9,
            bottom: 7,
            pointerEvents: "none",
            zIndex: 3,
            display: "flex",
            flexDirection: "column",
            gap: 3,
            alignItems: "stretch",
          }}
        >
          {/* Label and level share a row rather than each claiming the bottom
              edge, which is what made them overlap once labels were on. */}
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
                  fontSize: 9,
                  fontWeight: 600,
                  color: "rgba(255,255,255,0.72)",
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
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.3,
                color: levelMuted ? "#f87171" : "rgba(255,255,255,0.8)",
                textShadow: "0 1px 3px rgba(0,0,0,0.8)",
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

      {/* Label — volume keys draw their own above the rail, so this would be a
          second copy sitting on top of it. */}
      {showLabels && !isVolumeBtn && (
        <div
          style={{
            position: "absolute",
            bottom: 0,
            left: 0,
            right: 0,
            padding: "12px 5px 8px",
            background: "linear-gradient(transparent, rgba(0,0,0,0.72))",
            textAlign: "center",
            fontSize: 10,
            fontWeight: 600,
            color: "rgba(255,255,255,0.8)",
            letterSpacing: 0.1,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            borderRadius: "0 0 13px 13px",
            fontFamily: "'DM Sans', system-ui, sans-serif",
          }}
        >
          {btn.label}
        </div>
      )}
    </div>
  );
}

// The native colour input streams an event on every pointer move while the OS
// picker is open — far faster than a frame — and each one re-rendered the whole
// editor. This coalesces them to roughly one per frame.
//
// A timer rather than requestAnimationFrame: rAF does not run while the window
// is hidden or minimised, which would strand the last patch and silently lose
// the colour the user picked. The input still reads straight from form.color,
// so no local mirror of the value is needed.
const FRAME_MS = 16;

function useCoalescedPatch(onPatch) {
  const timerRef = useRef(0);
  const pendingRef = useRef(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (patch) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = 0;
        const queued = pendingRef.current;
        pendingRef.current = null;
        if (queued) onPatch(queued);
      }, FRAME_MS);
    },
    [onPatch],
  );
}

// ─── Property Panel ───────────────────────────────────────────────────────────

function PropertyPanel({
  btn,
  form,
  saving,
  saved,
  dirty,
  audioDevices,
  inputDevices,
  audioSessions,
  onPatch,
  onSave,
  onRevert,
  onDelete,
  onUploadIcon,
  onUploadSound,
  onDeleteSound,
}) {
  const iconRef = useRef();
  const soundRef = useRef();
  const patchColor = useCoalescedPatch(onPatch);

  // Advanced stays shut for a plain key, but opens on its own when the key is
  // already using one of these — a configured setting must never be hidden.
  const usesAdvanced =
    !!form.is_toggle ||
    form.button_mode === "multi" ||
    form.button_mode === "multi_switch" ||
    form.actions?.length > 0 ||
    !!form.sound_file;
  const [showAdvanced, setShowAdvanced] = useState(false);
  const advancedOpen = showAdvanced || usesAdvanced;

  if (!btn) {
    return (
      <div style={styles.panel}>
        <div style={styles.panelEmpty}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: "linear-gradient(160deg, #2a2a2a, #1c1c1c)",
              border: "1.5px solid #333333",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              marginBottom: 12,
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            <Icon name="settings" size={26} />
          </div>
          <div style={styles.panelEmptyText}>Select a key to configure it</div>
          <div style={styles.panelEmptyHint}>
            Drag a key to reorder the deck
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.panel}>
      <div style={styles.panelInner}>
        {/* Preview */}
        <div style={styles.headerBar}>
          <div style={styles.previewRow}>
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: 11,
                background: `linear-gradient(160deg, ${form.color}28, ${form.color}12)`,
                border: `1.5px solid ${form.color}50`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 22,
                position: "relative",
                overflow: "hidden",
                flexShrink: 0,
                boxShadow: `0 2px 10px rgba(0,0,0,0.5)`,
              }}
            >
              {form.icon_data ? (
                form.icon_data.startsWith("data:video/") ? (
                  <video
                    src={form.icon_data}
                    autoPlay
                    loop
                    muted
                    playsInline
                    style={{
                      width: "80%",
                      height: "80%",
                      objectFit: "contain",
                    }}
                  />
                ) : (
                  <img
                    src={form.icon_data}
                    style={{
                      width: "80%",
                      height: "80%",
                      objectFit: "contain",
                    }}
                  />
                )
              ) : (
                <ButtonFace icon={form.icon} size={26} />
              )}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={styles.previewLabel}>{form.label || "Untitled"}</div>
              <div style={styles.previewAction}>
                {actionTypeLabel(form.action_type)}
              </div>
            </div>
          </div>

          <div style={styles.headerActions}>
            {dirty && !saving ? (
              <span style={styles.dirtyPip} title="Unsaved changes">
                <span style={styles.dirtyDot} />
                Unsaved
              </span>
            ) : null}
            {dirty && !saving ? (
              <button
                style={styles.revertBtn}
                onClick={onRevert}
                title="Discard unsaved changes"
              >
                Revert
              </button>
            ) : null}
            <button
              style={{
                ...styles.saveBtn,
                ...(dirty || saving ? {} : styles.saveBtnClean),
              }}
              onClick={onSave}
              disabled={saving || !dirty}
            >
              {saving ? "Saving…" : saved ? "Saved" : "Save"}
            </button>
            <button
              style={styles.deleteBtn}
              onClick={onDelete}
              aria-label="Delete key"
            >
              <Icon name="delete" size={15} />
            </button>
          </div>
        </div>

        {/* Label */}
        <Field label="Label">
          <input
            value={form.label || ""}
            onChange={(e) => onPatch({ label: e.target.value })}
            placeholder="Button label"
          />
        </Field>

        {/* Icon */}
        <Field label="Icon">
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              value={form.icon || ""}
              onChange={(e) => onPatch({ icon: e.target.value })}
              placeholder="emoji or text"
              style={{ flex: 1 }}
            />
            <input
              ref={iconRef}
              type="file"
              accept="image/*,video/*"
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files[0]) onUploadIcon(e.target.files[0]);
                e.target.value = "";
              }}
            />
            <button
              style={styles.iconUploadBtn}
              onClick={() => iconRef.current?.click()}
              title="Upload image/GIF/video"
            >
              <Icon name="upload" size={14} />
            </button>
            {form.icon_data && (
              <button
                style={{ ...styles.iconUploadBtn, color: "#f87171" }}
                onClick={() => onPatch({ icon_data: null })}
                title="Remove image"
              >
                <Icon name="close" size={14} />
              </button>
            )}
          </div>
        </Field>

        {/* Color */}
        <Field label="Color">
          <div
            style={{
              display: "flex",
              gap: 5,
              flexWrap: "wrap",
              alignItems: "center",
            }}
          >
            {COLORS.map((c) => (
              <div
                key={c}
                style={{
                  width: 18,
                  height: 18,
                  borderRadius: 5,
                  background: c,
                  cursor: "pointer",
                  border:
                    form.color === c
                      ? "2px solid #fff"
                      : "2px solid transparent",
                  boxShadow: form.color === c ? `0 0 6px ${c}` : "none",
                  transition: "all 0.1s",
                  flexShrink: 0,
                }}
                onClick={() => onPatch({ color: c })}
              />
            ))}
            <input
              type="color"
              value={form.color || "#3d8fd6"}
              onChange={(e) => patchColor({ color: e.target.value })}
              style={{ width: 28, height: 22, padding: 2, borderRadius: 6 }}
            />
          </div>
        </Field>

        {/* Size */}
        <Field label="Size">
          <div style={{ display: "flex", gap: 6 }}>
            {["1x1", "2x2"].map((s) => (
              <button
                key={s}
                style={{
                  ...styles.segBtn,
                  ...(form.size === s ? styles.segBtnActive : {}),
                }}
                onClick={() => onPatch({ size: s })}
              >
                {s}
              </button>
            ))}
          </div>
        </Field>

        {/* FEATURE: Hold to confirm — property of the button, not of its actions,
            so it sits with Size rather than down in the action editors. */}
        <Field label="Confirm before running">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Toggle
              value={!!form.require_confirm}
              onChange={(v) => onPatch({ require_confirm: v ? 1 : 0 })}
            />
            <span style={styles.fieldHint}>Hold on phone to fire</span>
          </div>
        </Field>

        <div style={styles.panelDivider} />

        {form.button_mode !== "multi" &&
        form.button_mode !== "multi_switch" &&
        !(form.actions?.length > 0) ? (
          <ActionEditor
            action={{
              action_type: form.action_type || "keystroke",
              action_value: form.action_value || "",
            }}
            onChange={onPatch}
            audioDevices={audioDevices}
            inputDevices={inputDevices}
            audioSessions={audioSessions}
          />
        ) : null}

        <button
          style={styles.disclosure}
          onClick={() => setShowAdvanced((v) => !v)}
          aria-expanded={advancedOpen}
        >
          <Icon
            name={advancedOpen ? "chevronDown" : "chevronRight"}
            size={14}
          />
          Advanced
          {usesAdvanced && !showAdvanced ? (
            <span style={styles.disclosureNote}>in use</span>
          ) : null}
        </button>

        {advancedOpen ? (
          <>
            {/* Toggle */}
            <Field label="Toggle mode">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Toggle
                  value={!!form.is_toggle}
                  onChange={(v) => onPatch({ is_toggle: v ? 1 : 0 })}
                />
                <span style={{ fontSize: 11, color: "#666" }}>
                  Button toggles on/off
                </span>
              </div>
            </Field>

            {form.is_toggle ? (
              <ActionEditor
                title="Toggle OFF action"
                action={{
                  action_type: form.toggle_action_type || "keystroke",
                  action_value: form.toggle_action_value || "",
                }}
                onChange={(patch) =>
                  onPatch({
                    ...(patch.action_type !== undefined
                      ? { toggle_action_type: patch.action_type }
                      : {}),
                    ...(patch.action_value !== undefined
                      ? { toggle_action_value: patch.action_value }
                      : {}),
                  })
                }
                audioDevices={audioDevices}
                inputDevices={inputDevices}
                audioSessions={audioSessions}
              />
            ) : null}

            <Field label="Multi-action">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Toggle
                  value={
                    form.button_mode === "multi" ||
                    (form.actions?.length > 0 &&
                      form.button_mode !== "multi_switch")
                  }
                  onChange={(v) =>
                    onPatch({
                      button_mode: v ? "multi" : "single",
                      is_toggle: 0,
                      actions: v
                        ? form.actions?.length > 0
                          ? form.actions
                          : [
                              {
                                action_type: "keystroke",
                                action_value: "",
                                delay_ms: 0,
                              },
                            ]
                        : null,
                    })
                  }
                />
                <span style={{ fontSize: 11, color: "#666" }}>
                  Run a sequence of actions
                </span>
              </div>
            </Field>

            {form.button_mode === "multi" || form.actions?.length > 0 ? (
              <ActionStackEditor
                title="Steps"
                actions={form.actions || []}
                onChange={(actions) =>
                  onPatch({ actions, button_mode: "multi" })
                }
                audioDevices={audioDevices}
                inputDevices={inputDevices}
                audioSessions={audioSessions}
              />
            ) : null}

            <Field label="Multi-action switch">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <Toggle
                  value={form.button_mode === "multi_switch"}
                  onChange={(v) =>
                    onPatch({
                      button_mode: v ? "multi_switch" : "single",
                      is_toggle: 0,
                      actions: null,
                      switch_actions_a:
                        form.switch_actions_a?.length > 0
                          ? form.switch_actions_a
                          : [
                              {
                                action_type: "keystroke",
                                action_value: "",
                                delay_ms: 0,
                              },
                            ],
                      switch_actions_b:
                        form.switch_actions_b?.length > 0
                          ? form.switch_actions_b
                          : [
                              {
                                action_type: "keystroke",
                                action_value: "",
                                delay_ms: 0,
                              },
                            ],
                    })
                  }
                />
                <span style={{ fontSize: 11, color: "#666" }}>
                  Alternate between two stacks
                </span>
              </div>
            </Field>

            {form.button_mode === "multi_switch" ? (
              <>
                <ActionStackEditor
                  title="Stack A"
                  actions={form.switch_actions_a || []}
                  onChange={(actions) => onPatch({ switch_actions_a: actions })}
                  audioDevices={audioDevices}
                  inputDevices={inputDevices}
                  audioSessions={audioSessions}
                />
                <ActionStackEditor
                  title="Stack B"
                  actions={form.switch_actions_b || []}
                  onChange={(actions) => onPatch({ switch_actions_b: actions })}
                  audioDevices={audioDevices}
                  inputDevices={inputDevices}
                  audioSessions={audioSessions}
                />
              </>
            ) : null}

            <div style={styles.panelDivider} />

            {/* Sound */}
            <Field label="Button sound">
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {form.sound_file ? (
                  <div style={{ display: "flex", gap: 6 }}>
                    <div style={styles.soundChip}>
                      <Icon name="sound" size={12} /> Sound attached
                    </div>
                    <button
                      style={{ ...styles.iconUploadBtn, color: "#f87171" }}
                      onClick={onDeleteSound}
                      title="Remove sound"
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      ref={soundRef}
                      type="file"
                      accept="audio/*"
                      style={{ display: "none" }}
                      onChange={(e) => {
                        if (e.target.files[0]) onUploadSound(e.target.files[0]);
                        e.target.value = "";
                      }}
                    />
                    <button
                      style={styles.uploadBtn}
                      onClick={() => soundRef.current?.click()}
                    >
                      Upload sound
                    </button>
                  </>
                )}
                <div style={{ display: "flex", gap: 4 }}>
                  {SOUND_TARGETS.map((t) => (
                    <button
                      key={t.value}
                      style={{
                        ...styles.segBtn,
                        flex: 1,
                        fontSize: 10,
                        ...(form.sound_target === t.value
                          ? styles.segBtnActive
                          : {}),
                      }}
                      onClick={() => onPatch({ sound_target: t.value })}
                    >
                      <Icon name={t.icon} size={12} />
                      {t.label}
                    </button>
                  ))}
                </div>
              </div>
            </Field>
          </>
        ) : null}

        <div style={styles.panelDivider} />
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

function ActionTypeSelect({ value, onChange }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {ACTION_CATEGORIES.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.actions.map((action) => (
            <option key={action.id} value={action.id}>
              {action.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

function ActionEditor({
  title = "Action",
  action,
  onChange,
  audioDevices,
  inputDevices,
  audioSessions,
}) {
  return (
    <>
      <Field label={title}>
        <ActionTypeSelect
          value={action.action_type || "keystroke"}
          onChange={(type) => onChange(applyActionTypeDefaults(action, type))}
        />
      </Field>
      <ActionFields
        action={action}
        onChange={onChange}
        audioDevices={audioDevices}
        inputDevices={inputDevices}
        audioSessions={audioSessions}
      />
    </>
  );
}

function ActionFields({
  action,
  onChange,
  audioDevices,
  inputDevices,
  audioSessions,
}) {
  const meta = ACTION_BY_ID[action.action_type] || ACTION_BY_ID.keystroke;
  return (
    <>
      {(meta.fields || []).map((field, index) => (
        <ActionField
          key={`${field.key || field.type}-${index}`}
          field={field}
          action={action}
          onChange={onChange}
          audioDevices={audioDevices}
          inputDevices={inputDevices}
          audioSessions={audioSessions}
        />
      ))}
    </>
  );
}

function ActionField({
  field,
  action,
  onChange,
  audioDevices,
  inputDevices,
  audioSessions,
}) {
  const value = action[field.key] || "";

  if (field.type === "info") {
    return (
      <Field label="Details">
        <div style={{ fontSize: 11, color: "#666" }}>{field.text}</div>
      </Field>
    );
  }

  if (field.type === "range") {
    const current = parseInt(value) || Number(field.min || 0);
    return (
      <Field label={field.label}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="range"
            min={field.min}
            max={field.max}
            value={current}
            onChange={(e) => onChange({ [field.key]: e.target.value })}
          />
          <span style={{ minWidth: 34, fontSize: 11, color: "#3d8fd6" }}>
            {current}
            {field.suffix || ""}
          </span>
        </div>
      </Field>
    );
  }

  if (field.type === "number") {
    return (
      <Field label={field.label}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="number"
            min={field.min}
            step={field.step}
            value={value}
            onChange={(e) => onChange({ [field.key]: e.target.value })}
          />
          {field.suffix && (
            <span style={{ fontSize: 11, color: "#666" }}>{field.suffix}</span>
          )}
        </div>
      </Field>
    );
  }

  if (field.type === "app_picker" || field.type === "app_level") {
    const { app, amount } = unpackAppValue(value);
    const level =
      amount === "" ? field.fallback : (parseInt(amount) ?? field.fallback);

    // Windows only lists a session while the app holds the audio device, so a
    // previously-chosen app disappears from the list when it is closed or
    // silent. It stays selectable so the button does not silently lose its
    // target — it is just marked as not currently playing.
    const running = [...new Set(audioSessions.map((s) => s.processName))].sort(
      (a, b) => a.localeCompare(b),
    );
    const options = app && !running.includes(app) ? [app, ...running] : running;

    return (
      <>
        <Field label={field.label}>
          <select
            value={app}
            onChange={(e) =>
              onChange({
                [field.key]:
                  field.type === "app_level"
                    ? packAppValue(e.target.value, level)
                    : packAppValue(e.target.value),
              })
            }
          >
            <option value="">— select application —</option>
            {options.map((name) => (
              <option key={name} value={name}>
                {name}
                {running.includes(name) ? "" : " — not playing"}
              </option>
            ))}
          </select>
        </Field>
        {field.type === "app_level" && (
          <Field label={field.amountLabel}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <input
                type="range"
                min={field.min}
                max={field.max}
                value={level}
                onChange={(e) =>
                  onChange({ [field.key]: packAppValue(app, e.target.value) })
                }
                style={{ flex: 1 }}
              />
              <span style={{ minWidth: 38, textAlign: "right" }}>{level}%</span>
            </div>
          </Field>
        )}
      </>
    );
  }

  if (field.type === "input_device") {
    return (
      <Field label={field.label}>
        <select
          value={value}
          onChange={(e) => onChange({ [field.key]: e.target.value })}
        >
          <option value="">— select device —</option>
          {inputDevices.map((d) => (
            <option key={d.id} value={d.name}>
              {d.name}
              {d.isDefault ? " (default)" : ""}
              {d.state !== "active" ? " — not connected" : ""}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.type === "audio_device") {
    return (
      <Field label={field.label}>
        <select
          value={value}
          onChange={(e) => onChange({ [field.key]: e.target.value })}
        >
          <option value="">— select device —</option>
          {audioDevices.map((d) => (
            <option key={d.id} value={d.name}>
              {d.name}
              {d.isDefault ? " (default)" : ""}
              {d.state !== "active" ? " — not connected" : ""}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (field.type === "file") {
    return (
      <Field label={field.label}>
        <div style={{ display: "flex", gap: 6 }}>
          <input
            value={value}
            onChange={(e) => onChange({ [field.key]: e.target.value })}
            placeholder={field.placeholder}
            style={{ flex: 1 }}
          />
          <button
            style={styles.iconUploadBtn}
            onClick={async () => {
              try {
                const path = await window.electronAPI?.system.pickFile();
                if (path) onChange({ [field.key]: path });
              } catch {
                /* ignore */
              }
            }}
          >
            <Icon name="upload" size={14} />
          </button>
        </div>
      </Field>
    );
  }

  return (
    <Field label={field.label}>
      <input
        value={value}
        onChange={(e) => onChange({ [field.key]: e.target.value })}
        placeholder={field.placeholder}
      />
    </Field>
  );
}

function ActionStackEditor({
  title,
  actions,
  onChange,
  audioDevices,
  inputDevices,
  audioSessions,
}) {
  const safeActions = actions || [];

  function patchStep(index, patch) {
    onChange(
      safeActions.map((step, i) =>
        i === index ? { ...step, ...patch } : step,
      ),
    );
  }

  return (
    <Field label={title}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {safeActions.map((step, index) => (
          <div
            key={index}
            style={{
              background: "#141414",
              border: "1px solid #2b2b2b",
              borderRadius: 8,
              padding: 8,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 6,
              }}
            >
              <span style={{ fontSize: 10, color: "#606060" }}>
                Step {index + 1} · {actionTypeLabel(step.action_type)}
              </span>
              <button
                style={{ ...styles.iconUploadBtn, width: 24, height: 24 }}
                onClick={() =>
                  onChange(safeActions.filter((_, i) => i !== index))
                }
              >
                <Icon name="close" size={14} />
              </button>
            </div>
            <ActionTypeSelect
              value={step.action_type || "keystroke"}
              onChange={(type) =>
                patchStep(index, applyActionTypeDefaults(step, type))
              }
            />
            <div style={{ height: 6 }} />
            <ActionFields
              action={step}
              onChange={(patch) => patchStep(index, patch)}
              audioDevices={audioDevices}
              inputDevices={inputDevices}
              audioSessions={audioSessions}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 10, color: "#606060" }}>Wait after</span>
              <input
                type="number"
                min="0"
                step="50"
                value={step.delay_ms || 0}
                onChange={(e) =>
                  patchStep(index, { delay_ms: parseInt(e.target.value) || 0 })
                }
              />
              <span style={{ fontSize: 10, color: "#606060" }}>ms</span>
            </div>
          </div>
        ))}
        <button
          style={styles.uploadBtn}
          onClick={() =>
            onChange([
              ...safeActions,
              { action_type: "keystroke", action_value: "", delay_ms: 0 },
            ])
          }
        >
          + Add step
        </button>
      </div>
    </Field>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    background: "#161616",
    fontFamily: "'DM Sans', system-ui, sans-serif",
    color: "#cecece",
    overflow: "hidden",
  },

  // ── Top bar ──
  topBar: {
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    height: 48,
    flexShrink: 0,
    background: "#121212",
    borderBottom: "1px solid #232323",
    gap: 10,
  },
  topBarLogo: { display: "flex", alignItems: "center", gap: 8, marginRight: 2 },
  logoDivider: { width: 1, height: 20, background: "#303030", marginLeft: 8 },
  logoText: {
    fontWeight: 700,
    fontSize: 13,
    color: "#e6e6e6",
    letterSpacing: 0.2,
  },
  topBarStats: { display: "flex", gap: 4, alignItems: "center" },
  topBarRight: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  topBarBtn: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 12px",
    background: "rgba(255,255,255,0.05)",
    border: "1px solid #333333",
    borderRadius: 8,
    color: "#949494",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.12s",
  },
  topBarBtnActive: {
    background: "rgba(52,211,153,0.1)",
    border: "1px solid rgba(52,211,153,0.3)",
    color: "#34d399",
  },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 4,
    background: "#1e1e1e",
    border: "1px solid #2b2b2b",
    borderRadius: 7,
    padding: "3px 8px",
  },
  chipWarn: { background: "#251508", border: "1px solid #4a2a10" },
  connBadge: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    borderRadius: 8,
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
  },
  connOn: {
    background: "#0a1f14",
    border: "1px solid #1a4a2a",
    color: "#34d399",
  },
  connWarn: {
    background: "#251508",
    border: "1px solid #4a2a10",
    color: "#fb923c",
  },
  connOff: {
    background: "#1f0a0a",
    border: "1px solid #3a1414",
    color: "#f87171",
  },
  connDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    animation: "pulse 2s infinite",
  },

  // ── Body ──
  body: { flex: 1, display: "flex", minHeight: 0, overflow: "hidden" },

  // ── Center grid ──
  // ── Canvas column ──
  // The deck is the subject, so it gets the room the sidebar used to take.
  canvasCol: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    background: "var(--bg-base)",
    overflow: "hidden",
  },
  canvasHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    padding: "10px 20px 6px",
    flexShrink: 0,
  },

  // Profile dropdown — the switcher, stacked over its own summary line.
  profileWrap: { position: "relative", minWidth: 0 },
  profileTrigger: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    background: "transparent",
    border: 0,
    padding: "2px 6px",
    marginLeft: -6,
    borderRadius: "var(--radius-sm)",
    color: "var(--text-primary)",
    cursor: "pointer",
    transition: "background var(--duration-base) var(--ease-out)",
  },
  profileName: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    maxWidth: 280,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  profileMeta: {
    fontSize: 11,
    color: "var(--text-muted)",
    paddingLeft: 0,
    marginTop: 1,
  },

  menu: {
    position: "absolute",
    top: "calc(100% + 8px)",
    left: -6,
    minWidth: 268,
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-lg)",
    boxShadow: "var(--shadow-lg)",
    padding: 6,
    zIndex: "var(--z-overlay)",
  },
  menuLabel: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "var(--text-secondary)",
    padding: "6px 8px 4px",
  },
  menuItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 8px",
    borderRadius: "var(--radius-md)",
    cursor: "pointer",
    color: "var(--text-secondary)",
    fontSize: 13,
  },
  menuItemActive: {
    background: "var(--accent-soft)",
    color: "var(--text-primary)",
  },
  menuCheck: {
    width: 14,
    display: "grid",
    placeItems: "center",
    color: "var(--accent)",
  },
  menuItemName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontWeight: 500,
  },
  menuRuleDot: {
    width: 5,
    height: 5,
    borderRadius: "50%",
    background: "var(--accent)",
    flexShrink: 0,
  },
  menuCount: { fontSize: 11, color: "var(--text-muted)", fontWeight: 600 },
  menuDelete: {
    display: "grid",
    placeItems: "center",
    width: 20,
    height: 20,
    background: "transparent",
    border: 0,
    borderRadius: "var(--radius-sm)",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  menuDivider: {
    height: 1,
    background: "var(--border-subtle)",
    margin: "6px 2px",
  },
  menuAction: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    width: "100%",
    padding: "8px",
    background: "transparent",
    border: 0,
    borderRadius: "var(--radius-md)",
    color: "var(--text-secondary)",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    textAlign: "left",
  },
  menuAddRow: { display: "flex", gap: 6, padding: 4 },
  menuInput: {
    flex: 1,
    minWidth: 0,
    background: "var(--bg-surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-primary)",
    padding: "6px 9px",
    fontSize: 13,
  },
  menuPrimary: {
    background: "var(--accent)",
    border: 0,
    borderRadius: "var(--radius-md)",
    color: "#fff",
    fontSize: 12,
    fontWeight: 600,
    padding: "0 12px",
    cursor: "pointer",
  },

  // The deck sits centred in whatever room is left, like hardware on a desk.
  canvas: {
    flex: 1,
    minHeight: 0,
    // No scrolling: keys are measured to fit this box, so the whole deck is
    // always on screen. The library is the only scrolling region.
    overflow: "hidden",
    display: "grid",
    // `safe` matters: plain centring clips the first row under the header once
    // the deck overflows, and no amount of scrolling brings it back.
    alignContent: "safe center",
    justifyContent: "safe center",
    padding: "8px 20px 12px",
  },

  pageRail: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: "6px 0 14px",
    flexShrink: 0,
  },
  pagePill: {
    minWidth: 30,
    height: 26,
    padding: "0 10px",
    display: "grid",
    placeItems: "center",
    borderRadius: "var(--radius-pill)",
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-subtle)",
    color: "var(--text-secondary)",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    transition: "background var(--duration-base) var(--ease-out)",
  },
  pagePillActive: {
    background: "var(--accent)",
    borderColor: "var(--accent)",
    color: "#fff",
  },

  iconBtn: {
    display: "grid",
    placeItems: "center",
    width: 32,
    height: 32,
    background: "transparent",
    border: 0,
    borderRadius: "var(--radius-md)",
    color: "var(--text-secondary)",
    cursor: "pointer",
  },

  // ── Actions library ──
  library: {
    width: "var(--library-width)",
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-surface)",
    borderLeft: "1px solid var(--border-subtle)",
    minHeight: 0,
  },
  libraryHead: {
    padding: 12,
    borderBottom: "1px solid var(--border-subtle)",
    flexShrink: 0,
  },
  searchWrap: { position: "relative", display: "flex", alignItems: "center" },
  searchIcon: {
    position: "absolute",
    left: 10,
    display: "grid",
    color: "var(--text-muted)",
    pointerEvents: "none",
  },
  searchInput: {
    width: "100%",
    background: "var(--bg-base)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-md)",
    color: "var(--text-primary)",
    padding: "8px 30px 8px 32px",
    fontSize: 13,
  },
  searchClear: {
    position: "absolute",
    right: 6,
    display: "grid",
    placeItems: "center",
    width: 22,
    height: 22,
    background: "transparent",
    border: 0,
    borderRadius: "var(--radius-sm)",
    color: "var(--text-muted)",
    cursor: "pointer",
  },
  libraryList: { flex: 1, minHeight: 0, overflowY: "auto", padding: 6 },
  libraryEmpty: {
    padding: "28px 12px",
    textAlign: "center",
    color: "var(--text-muted)",
    fontSize: 13,
  },
  libraryHint: {
    padding: "10px 14px",
    borderTop: "1px solid var(--border-subtle)",
    color: "var(--text-muted)",
    fontSize: 11,
    lineHeight: 1.5,
    flexShrink: 0,
  },
  catHead: {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "9px 10px",
    background: "transparent",
    border: 0,
    borderRadius: "var(--radius-md)",
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    textAlign: "left",
  },
  catChevron: {
    display: "grid",
    color: "var(--text-muted)",
    transition: "transform var(--duration-base) var(--ease-out)",
  },
  catName: { flex: 1, minWidth: 0 },
  catCount: { fontSize: 11, color: "var(--text-muted)", fontWeight: 600 },
  catItems: { padding: "2px 0 6px 14px" },
  actionRow: {
    display: "flex",
    alignItems: "center",
    gap: 9,
    padding: "7px 10px",
    borderRadius: "var(--radius-md)",
    color: "var(--text-secondary)",
    fontSize: 13,
    cursor: "grab",
    userSelect: "none",
    transition: "background var(--duration-base) var(--ease-out)",
  },
  actionRowDragging: { opacity: 0.4, cursor: "grabbing" },
  actionRowName: {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  actionRowGrip: { display: "grid", color: "var(--text-muted)", opacity: 0.5 },

  actionGhost: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "8px 12px",
    borderRadius: "var(--radius-md)",
    background: "var(--bg-elevated)",
    border: "1px solid var(--accent)",
    color: "var(--text-primary)",
    fontSize: 13,
    fontWeight: 600,
    boxShadow: "var(--shadow-md)",
    cursor: "grabbing",
  },
  addSlotOver: {
    borderColor: "var(--accent)",
    background: "var(--accent-soft)",
    color: "var(--accent)",
  },

  // ── Rule editor modal ──
  modalBackdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.62)",
    backdropFilter: "blur(4px)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: "var(--z-modal)",
    padding: 24,
  },
  modalCard: {
    width: "100%",
    maxWidth: 520,
    maxHeight: "84vh",
    display: "flex",
    flexDirection: "column",
    background: "var(--bg-surface)",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-xl)",
    boxShadow: "var(--shadow-lg)",
    overflow: "hidden",
  },
  modalHead: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
    padding: "16px 16px 12px 20px",
    borderBottom: "1px solid var(--border-subtle)",
    flexShrink: 0,
  },
  modalTitle: { fontSize: 15, fontWeight: 700, color: "var(--text-primary)" },
  modalSub: { fontSize: 12, color: "var(--text-muted)", marginTop: 2 },
  modalBody: { overflowY: "auto", padding: "4px 6px 12px" },

  // Keys are a fixed size and the grid is centred, so the deck reads as a piece
  // of hardware rather than a responsive layout that reflows as you resize.
  // Up to 8 across, mirroring a Stream Deck XL, so a full deck is visible at
  // once instead of scrolling. Narrow windows simply fit fewer per row.
  // Columns and key size are computed against the measured canvas and applied
  // inline; only the invariants live here.
  grid: {
    display: "grid",
    gap: 12,
    justifyContent: "center",
    alignContent: "center",
  },
  addSlot: {
    aspectRatio: "1/1",
    borderRadius: 8,
    border: "1.5px dashed #2b2b2b",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "all 0.12s",
    background: "transparent",
  },

  // ── Property panel ──
  // ── Inspector drawer ──
  // Short and wide beneath the canvas rather than a tall column beside it, so
  // the deck gets the full window width and the fields flow into columns.
  panel: {
    flexShrink: 0,
    // A fixed height, not a content-driven one. When the drawer grew with its
    // contents it pushed the deck up, so adding a key scrolled the one you just
    // made out of sight. Fixed here means the canvas keeps a known area and
    // sizes its keys to it; overflow scrolls inside the drawer instead.
    height: 264,
    background: "var(--bg-surface)",
    borderTop: "1px solid var(--border-subtle)",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  // Multi-column flow: the same fields as before, laid across instead of down.
  // auto-fill keeps it sensible from a narrow window up to a wide one.
  panelInner: {
    padding: "12px 20px 14px",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    alignContent: "start",
    gap: "0 24px",
    animation: "slideIn 0.16s ease",
  },
  panelEmpty: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    padding: 24,
  },
  panelEmptyText: {
    fontSize: 13,
    color: "var(--text-muted)",
    textAlign: "center",
    lineHeight: 1.7,
  },
  panelEmptyHint: {
    fontSize: 12,
    color: "var(--text-muted)",
    opacity: 0.7,
    textAlign: "center",
    marginTop: 4,
  },
  // A column separator would be wrong in a grid, so dividers span the full row.
  panelDivider: {
    gridColumn: "1 / -1",
    height: 1,
    background: "var(--border-subtle)",
    margin: "10px 0",
  },

  // Sits in the flow as its own column, like the key preview on the left of
  // Stream Deck's inspector, rather than claiming a whole row.
  previewRow: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    marginBottom: 6,
    minWidth: 0,
  },
  previewLabel: {
    fontSize: 14,
    fontWeight: 700,
    color: "#e6e6e6",
    marginBottom: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  previewAction: { fontSize: 11, color: "#494949" },

  field: { marginBottom: 6, minWidth: 0 },
  fieldLabel: {
    display: "block",
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-secondary)",
    letterSpacing: "0.07em",
    marginBottom: 5,
    textTransform: "uppercase",
  },

  segBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    padding: "5px 11px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 600,
    background: "#1e1e1e",
    border: "1px solid #333333",
    color: "#606060",
    cursor: "pointer",
    transition: "all 0.1s",
  },
  segBtnActive: {
    background: "rgba(79,128,255,0.15)",
    border: "1px solid rgba(79,128,255,0.4)",
    color: "#3d8fd6",
  },

  iconUploadBtn: {
    width: 30,
    height: 30,
    borderRadius: 7,
    background: "#1e1e1e",
    border: "1px solid #333333",
    color: "#828282",
    cursor: "pointer",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },

  soundChip: {
    flex: 1,
    padding: "6px 10px",
    borderRadius: 7,
    background: "#0a180e",
    border: "1px solid #1a3a22",
    fontSize: 11,
    color: "#34d399",
  },
  uploadBtn: {
    width: "100%",
    padding: "7px 12px",
    borderRadius: 7,
    fontSize: 11,
    background: "#1e1e1e",
    border: "1px dashed #333333",
    color: "#606060",
    cursor: "pointer",
    transition: "all 0.12s",
  },

  // Save/Delete span the drawer so they stay findable regardless of how many
  // columns the fields happen to flow into.
  headerBar: {
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    gap: 14,
    paddingBottom: 10,
    marginBottom: 10,
    borderBottom: "1px solid var(--border-subtle)",
  },
  headerActions: {
    marginLeft: "auto",
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  dirtyPip: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 11,
    fontWeight: 600,
    color: "var(--warning)",
    padding: "5px 10px",
    borderRadius: "var(--radius-pill)",
    background: "var(--warning-soft)",
    border: "1px solid rgba(251,191,36,0.30)",
  },
  dirtyDot: {
    width: 6,
    height: 6,
    borderRadius: "50%",
    background: "var(--warning)",
  },
  fieldHint: { fontSize: 11, color: "var(--text-muted)" },
  disclosure: {
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    gap: 7,
    width: "fit-content",
    margin: "6px 0 10px",
    padding: "6px 10px 6px 6px",
    background: "transparent",
    border: 0,
    borderRadius: "var(--radius-md)",
    color: "var(--text-secondary)",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    cursor: "pointer",
  },
  disclosureNote: {
    textTransform: "none",
    letterSpacing: 0,
    fontWeight: 500,
    fontSize: 11,
    color: "var(--accent)",
  },
  saveBtnClean: {
    background: "var(--bg-elevated)",
    border: "1px solid var(--border-subtle)",
    color: "var(--text-muted)",
    cursor: "default",
  },
  saveBtn: {
    padding: "8px 18px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 700,
    background: "var(--accent)",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    transition: "opacity 0.12s",
  },
  // Quieter than Save on purpose: discarding is the secondary path, so it reads
  // as an outline beside the filled primary rather than competing with it.
  revertBtn: {
    padding: "8px 14px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 600,
    background: "transparent",
    border: "1px solid var(--border-strong)",
    color: "var(--text-secondary)",
    cursor: "pointer",
    transition: "color 0.12s, border-color 0.12s",
  },
  deleteBtn: {
    padding: "9px 12px",
    borderRadius: 8,
    fontSize: 11,
    fontWeight: 600,
    background: "#1f0a0a",
    border: "1px solid #3a1414",
    color: "#f87171",
    cursor: "pointer",
    transition: "all 0.12s",
  },
};

// ─── Rule Editor Styles ───────────────────────────────────────────────────────

const ruleStyles = {
  panel: {
    margin: "0 8px 12px",
    padding: "12px 10px",
    borderRadius: 10,
    background: "#141414",
    border: "1px solid #252525",
    display: "flex",
    flexDirection: "column",
    gap: 9,
  },
  header: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 8,
  },
  title: {
    fontSize: 11,
    fontWeight: 700,
    color: "#3d8fd6",
    marginBottom: 2,
    letterSpacing: 0.3,
  },
  meta: {
    fontSize: 10,
    color: "#494949",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    maxWidth: 160,
  },
  enabledRow: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    cursor: "pointer",
    flexShrink: 0,
  },
  actions: {
    display: "flex",
    gap: 5,
    flexWrap: "wrap",
  },
  smallBtn: {
    background: "#202020",
    border: "1px solid #333333",
    borderRadius: 6,
    color: "#989898",
    cursor: "pointer",
    padding: "4px 8px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  dangerBtn: {
    background: "#1f0a0a",
    border: "1px solid #3a1414",
    borderRadius: 6,
    color: "#f87171",
    cursor: "pointer",
    padding: "4px 8px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  settingsRow: {
    display: "grid",
    gridTemplateColumns: "auto auto auto auto auto auto",
    gap: "5px 6px",
    alignItems: "center",
  },
  miniLabel: {
    fontSize: 10,
    color: "#4f4f4f",
    fontWeight: 700,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  compactSelect: {
    background: "#202020",
    border: "1px solid #333333",
    borderRadius: 6,
    color: "#cecece",
    padding: "4px 6px",
    fontSize: 11,
    outline: "none",
    fontFamily: "'DM Sans', system-ui, sans-serif",
    boxSizing: "border-box",
  },
  compactInput: {
    background: "#202020",
    border: "1px solid #333333",
    borderRadius: 6,
    color: "#cecece",
    padding: "4px 6px",
    fontSize: 11,
    outline: "none",
    width: 52,
    boxSizing: "border-box",
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  condSelect: {
    background: "#202020",
    border: "1px solid #333333",
    borderRadius: 6,
    color: "#cecece",
    padding: "5px 20px 5px 8px",
    fontSize: 11,
    outline: "none",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    appearance: "none",
    WebkitAppearance: "none",
    MozAppearance: "none",
    backgroundImage:
      "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'%3E%3Cpath d='M2 3.5L5 6.5L8 3.5' stroke='%238888a8' stroke-width='1.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")",
    backgroundRepeat: "no-repeat",
    backgroundPosition: "right 6px center",
    backgroundSize: "10px",
  },
  conditionRow: {
    display: "grid",
    gridTemplateColumns: "1.4fr 1.2fr 1.6fr 14px 14px",
    gap: 6,
    alignItems: "center",
    width: "100%",
  },
  condInput: {
    background: "#202020",
    border: "1px solid #333333",
    borderRadius: 6,
    color: "#cecece",
    padding: "5px 8px",
    fontSize: 11,
    outline: "none",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    fontFamily: "DM Sans, system-ui, sans-serif",
  },
  removeCondBtn: {
    width: 14,
    height: 14,
    display: "grid",
    placeItems: "center",
    background: "transparent",
    border: "none",
    color: "#666666",
    fontSize: 11,
    cursor: "pointer",
    padding: 0,
    lineHeight: 1,
    transition: "color 0.15s ease, transform 0.15s ease",
  },
  addCondBtn: {
    alignSelf: "flex-start",
    background: "none",
    border: "1px dashed #333333",
    borderRadius: 6,
    color: "#4f4f4f",
    cursor: "pointer",
    padding: "4px 8px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  delayRow: {
    background: "#181818",
    border: "1px solid #2f2f2f",
    borderRadius: 7,
    padding: "8px 10px",
  },
  picker: {
    borderRadius: 8,
    border: "1px solid #333333",
    background: "#101010",
    overflow: "hidden",
  },
  pickerHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "7px 10px",
    borderBottom: "1px solid #232323",
    color: "#cecece",
    fontSize: 11,
    fontWeight: 700,
  },
  pickerClose: {
    background: "none",
    border: "none",
    color: "#4f4f4f",
    cursor: "pointer",
    fontSize: 10,
  },
  pickerList: {
    maxHeight: 220,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  pickerItem: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "1px 8px",
    textAlign: "left",
    background: "none",
    border: "none",
    borderBottom: "1px solid #1e1e1e",
    color: "#cecece",
    cursor: "pointer",
    padding: "7px 10px",
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  pickerProcess: {
    fontSize: 11,
    fontWeight: 700,
    color: "#3d8fd6",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pickerTitle: {
    fontSize: 11,
    color: "#a0a0a0",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pickerPath: {
    gridColumn: "1 / -1",
    fontSize: 9,
    color: "#454545",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: 1,
  },
  pickerEmpty: { padding: 10, fontSize: 11, color: "#454545" },
};

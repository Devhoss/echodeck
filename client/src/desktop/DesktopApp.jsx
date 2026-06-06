/**
 * DesktopApp.jsx  —  client/src/desktop/DesktopApp.jsx
 *
 * Full Elgato-style desktop layout:
 *   LEFT   — profile/page sidebar with auto-switch rules
 *   CENTER — button grid with drag-to-reorder (reuses SortableButton from App.jsx)
 *   RIGHT  — property panel (inline editor, no full-screen overlay)
 *
 * Receives all live state (buttons, pages, stats, volume, ws) as props from App.jsx.
 * All mutations go through the same fetch() calls as ConfigUI — no new API surface.
 */

import { useCallback, useEffect, useRef, useState, memo, useMemo } from "react";
import QRCode from "qrcode";
import deckIcon from "/deck-icon.png";
import {
  DndContext,
  closestCenter,
  DragOverlay,
  PointerSensor,
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

const ACTION_GROUPS = [
  { label: "General", types: ["keystroke", "type", "shell", "url", "launch"] },
  {
    label: "Volume",
    types: ["volume_up", "volume_down", "volume_set", "volume_mute"],
  },
  { label: "Audio", types: ["audio_switch_device"] },
];
const ACTION_LABELS = {
  keystroke: "Keystroke",
  type: "Type Text",
  shell: "Shell Command",
  url: "Open URL",
  launch: "Launch App",
  volume_up: "Volume Up",
  volume_down: "Volume Down",
  volume_set: "Set Volume",
  volume_mute: "Toggle Mute",
  audio_switch_device: "Switch Audio Device",
};
const VOLUME_NO_VALUE = new Set(["volume_mute", "volume_up", "volume_down"]);
const VOLUME_ACTIONS = new Set([
  "volume_up",
  "volume_down",
  "volume_set",
  "volume_mute",
]);
const SOUND_TARGETS = [
  { value: "phone", label: "📱 Phone" },
  { value: "pc", label: "🖥️ PC" },
  { value: "both", label: "📱+🖥️ Both" },
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

const globalStyles = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&display=swap');

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
  ::-webkit-scrollbar-thumb { background:#2a2a32; border-radius:3px; }
  ::-webkit-scrollbar-thumb:hover { background:#3a3a48; }

  input, select, textarea {
    color-scheme: dark;
    background: #1e1e26;
    color: #d0d0d8;
    border: 1px solid #2c2c3a;
    border-radius: 7px;
    padding: 7px 10px;
    font-size: 12px;
    font-family: 'DM Sans', system-ui, sans-serif;
    width: 100%;
    outline: none;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  input:focus, select:focus, textarea:focus {
    border-color: #4f80ff;
    box-shadow: 0 0 0 2px rgba(79,128,255,0.15);
  }
  input[type=color] { padding:2px; height:26px; width:26px; cursor:pointer; border-radius:5px; }
  select option { background: #1e1e26; }

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
  wsRef,
  switchPage,
  pageButtonsCacheRef,
}) {
  const [selectedBtn, setSelectedBtn] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [activeId, setActiveId] = useState(null); // dnd drag overlay
  const [audioDevices, setAudioDevices] = useState([]);
  const [profileRules, setProfileRules] = useState([]);
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
  const [showLabels, setShowLabels] = useState(() => {
    try {
      const v = localStorage.getItem("deckShowLabels");
      return v === null ? true : v === "true";
    } catch {
      return true;
    }
  });
  const [showAudioSettings, setShowAudioSettings] = useState(false);
  const [pcSoundDevice, setPcSoundDevice] = useState("");
  const [audioSettingsSaved, setAudioSettingsSaved] = useState(false);

  // Derive button counts from the cache ref + live buttons for current page
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

  // Load supporting data once
  useEffect(() => {
    fetch(`${api()}/audio-devices`)
      .then((r) => r.json())
      .then(setAudioDevices)
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
      })
      .catch(() => {});
    return () => clearInterval(captureTimerRef.current);
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
      setForm({
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
        sound_file: btn.sound_file || null,
        sound_target: btn.sound_target || "phone",
        audio_device: btn.audio_device || null,
      });
      setSaved(false);
    },
    [currentPage],
  );

  function askConfirm(message, onConfirm) {
    setConfirmModal({ message, onConfirm });
  }

  async function openPairQR() {
    const api = getApiUrl();
    const data = await fetch(`${api}/pair-info`).then((r) => r.json());
    const url = `echodeck://pair?host=${data.host}&port=${data.port}&token=${data.token}`;
    setPairUrl(url);
    const dataUrl = await QRCode.toDataURL(url, {
      width: 240,
      margin: 2,
      color: { dark: "#ffffff", light: "#13131600" },
    });
    setQrDataUrl(dataUrl);
    setShowQR(true);
  }

  // Deselect when page changes — track which page the selection belongs to
  // and derive nullification instead of calling setState inside an effect

  const resolvedSelected = selectedPage === currentPage ? selectedBtn : null;
  const resolvedForm = selectedPage === currentPage ? form : {};

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
    setTimeout(() => setSaved(false), 2000);
    const data = await reloadPages();
    const page = data.find((p) => p.id === currentPage);
    setButtons(page?.buttons || []);
    const updated = (page?.buttons || []).find(
      (b) => b.id === resolvedSelected,
    );
    if (updated) setForm((f) => ({ ...f, icon_data: updated.icon_data }));
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
    setAudioSettingsSaved(true);
    setTimeout(() => setAudioSettingsSaved(false), 2000);
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
      if (!over || active.id === over.id) return;
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
    [wsRef, setButtons],
  );

  // ── Derived ───────────────────────────────────────────────────────────────

  const isConnected = status === "connected";
  const selectedBtnData = buttons.find((b) => b.id === resolvedSelected);
  const buttonIds = buttons.map((b) => b.id);
  const activeBtn = buttons.find((b) => b.id === activeId);
  const currentRule = profileRules.find((r) => r.page_id === currentPage);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div style={styles.root}>
      <style>{globalStyles}</style>

      {/* ── Top bar ── */}
      <TopBar
        stats={stats}
        volume={volume}
        muted={muted}
        isConnected={isConnected}
        status={status}
        onPair={openPairQR}
        pairOpen={showQR}
        onAudioSettings={() => setShowAudioSettings(true)}
        audioSettingsOpen={showAudioSettings}
      />

      {/* ── Body ── */}
      <div style={styles.body}>
        {/* ── LEFT: Profile/page sidebar ── */}
        <Sidebar
          pages={pages}
          buttons={buttons}
          pageButtonCounts={pageButtonCounts}
          currentPage={currentPage}
          profileRules={profileRules}
          autoSwitch={autoSwitch}
          currentRule={currentRule}
          activeWindow={activeWindow}
          openWindows={openWindows}
          showAppPicker={showAppPicker}
          captureCountdown={captureCountdown}
          onSelectPage={(id) => {
            switchPage(id);
            setSelectedBtn(null);
          }}
          onAddPage={addPage}
          onDeletePage={deletePage}
          onToggleAutoSwitch={toggleAutoSwitch}
          onSaveRule={saveProfileRule}
          onDeleteRule={deleteProfileRule}
          onSelectRunningApp={loadOpenWindows}
          onPickApp={saveAppAsRule}
          onClosePicker={() => setShowAppPicker(false)}
          onCaptureDelayed={startDelayedCapture}
          onRefreshCurrentApp={getCurrentApp}
          addingPage={addingPage}
          setAddingPage={setAddingPage}
          newPageName={newPageName}
          setNewPageName={setNewPageName}
        />

        {/* ── CENTER: Button grid ── */}
        <div style={styles.center}>
          <div style={styles.gridHeader}>
            <span style={styles.gridTitle}>
              {pages.find((p) => p.id === currentPage)?.name || "—"}
            </span>
            <span style={styles.gridCount}>
              {buttons.length} button{buttons.length !== 1 ? "s" : ""}
            </span>
            <button style={styles.addBtnPill} onClick={addButton}>
              + Add Button
            </button>
            <button
              onClick={() =>
                setShowLabels((v) => {
                  const next = !v;
                  try {
                    localStorage.setItem("deckShowLabels", String(next));
                  } catch {
                    /* */
                  }
                  return next;
                })
              }
              style={{
                ...styles.addBtnPill,
                marginLeft: 8,
                background: showLabels
                  ? "rgba(79,128,255,0.14)"
                  : "rgba(255,255,255,0.04)",
                border: `1px solid ${showLabels ? "rgba(79,128,255,0.3)" : "#252530"}`,
                color: showLabels ? "#7aafff" : "#44445a",
              }}
              title="Toggle button labels"
            >
              {showLabels ? "Hide Labels" : "Show Labels"}
            </button>
          </div>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={buttonIds} strategy={rectSortingStrategy}>
              <div style={styles.grid}>
                {buttons.map((btn) => (
                  <DesktopSortableButton
                    key={btn.id}
                    btn={btn}
                    selected={resolvedSelected === btn.id}
                    volume={volume}
                    muted={muted}
                    onSelect={selectBtn}
                    showLabels={showLabels}
                  />
                ))}
                {/* Empty add slot */}
                <div style={styles.addSlot} onClick={addButton}>
                  <span style={styles.addSlotPlus}>+</span>
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
                  ghost
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        </div>

        {/* ── RIGHT: Property panel ── */}
        <PropertyPanel
          btn={selectedBtnData}
          form={resolvedForm}
          saving={saving}
          saved={saved}
          audioDevices={audioDevices}
          onPatch={patchForm}
          onSave={saveButton}
          onDelete={deleteButton}
          onUploadIcon={uploadIcon}
          onUploadSound={uploadSound}
          onDeleteSound={deleteSound}
        />
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
              background: "#1a1a22",
              border: "1px solid #2a2a35",
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
                color: "#a5b4fc",
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
                  background: "#0d0d10",
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
            animation: "fadeIn 0.15s ease",
          }}
          onClick={() => setShowAudioSettings(false)}
        >
          <div
            style={{
              background: "#16161e",
              border: "1px solid #2a2a38",
              borderRadius: 18,
              width: 440,
              maxWidth: "90vw",
              boxShadow: "0 24px 80px rgba(0,0,0,0.7)",
              overflow: "hidden",
              animation: "popIn 0.18s ease",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "16px 20px",
                borderBottom: "1px solid #1e1e2c",
                background: "#0f0f14",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 16 }}>🎛️</span>
                <span
                  style={{ fontWeight: 700, fontSize: 14, color: "#e0e0ec" }}
                >
                  Audio Settings
                </span>
              </div>
              <button
                onClick={() => setShowAudioSettings(false)}
                style={{
                  background: "none",
                  border: "none",
                  color: "#44445a",
                  cursor: "pointer",
                  fontSize: 16,
                  lineHeight: 1,
                  padding: "2px 6px",
                }}
              >
                ✕
              </button>
            </div>

            {/* Modal body */}
            <div style={{ padding: "20px 20px 24px" }}>
              {/* PC Soundboard Output Device */}
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
                  🖥️ PC Soundboard Output Device
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#6b3fa0",
                    marginBottom: 12,
                    lineHeight: 1.6,
                  }}
                >
                  The audio device ffplay uses when playing sounds to your PC.
                  Set it to your{" "}
                  <strong style={{ color: "#a855f7" }}>
                    Voicemeeter Input
                  </strong>{" "}
                  so Discord (or any app) can hear the soundboard.
                </div>

                <label
                  style={{
                    display: "block",
                    fontSize: 11,
                    fontWeight: 700,
                    color: "#c084fc",
                    marginBottom: 6,
                    letterSpacing: 0.3,
                  }}
                >
                  Device name
                </label>
                {audioDevices.length > 0 ? (
                  <select
                    value={pcSoundDevice}
                    onChange={(e) => setPcSoundDevice(e.target.value)}
                    style={{ marginBottom: 12 }}
                  >
                    <option value="">— system default —</option>
                    {audioDevices.map((d) => (
                      <option key={d.id} value={d.name}>
                        {d.name}
                        {d.isDefault ? " ✓" : ""}
                      </option>
                    ))}
                  </select>
                ) : (
                  <>
                    <div
                      style={{
                        fontSize: 11,
                        color: "#5a3080",
                        marginBottom: 8,
                      }}
                    >
                      No devices auto-detected. Enter the exact name from
                      Windows Sound settings.
                    </div>
                    <input
                      value={pcSoundDevice}
                      onChange={(e) => setPcSoundDevice(e.target.value)}
                      placeholder="Voicemeeter Input (VB-Audio Voicemeeter VAIO)"
                      style={{ marginBottom: 12 }}
                    />
                  </>
                )}

                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button
                    onClick={saveAudioSettings}
                    style={{
                      flex: 1,
                      padding: "8px 0",
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 700,
                      background: audioSettingsSaved
                        ? "linear-gradient(135deg,#1a4a2a,#1a5c34)"
                        : "linear-gradient(135deg,#7c3aed,#9333ea)",
                      border: "none",
                      color: audioSettingsSaved ? "#34d399" : "#fff",
                      cursor: "pointer",
                      transition: "all 0.15s",
                    }}
                  >
                    {audioSettingsSaved ? "✓ Saved!" : "Save"}
                  </button>
                  <button
                    onClick={() => {
                      fetch(`${api()}/audio-devices`)
                        .then((r) => r.json())
                        .then(setAudioDevices)
                        .catch(() => {});
                    }}
                    style={{
                      padding: "8px 12px",
                      borderRadius: 8,
                      fontSize: 11,
                      fontWeight: 600,
                      background: "#1a1a26",
                      border: "1px solid #2c2c3a",
                      color: "#7a7a8a",
                      cursor: "pointer",
                    }}
                  >
                    ↺ Refresh
                  </button>
                </div>
              </div>

              {/* Voicemeeter setup guide */}
              <div
                style={{
                  background: "#0f1a0f",
                  border: "1px solid #1a4a1a",
                  borderRadius: 12,
                  padding: 16,
                }}
              >
                <div
                  style={{
                    fontWeight: 700,
                    fontSize: 13,
                    color: "#4ade80",
                    marginBottom: 10,
                  }}
                >
                  🎙️ Voicemeeter Banana setup
                </div>
                {[
                  ["1", "Open Voicemeeter Banana"],
                  ["2", "Hardware Input 1 → select your real microphone"],
                  ["3", "Hardware Out A1 → select your speakers/headphones"],
                  [
                    "4",
                    'In Discord: Input Device → "Voicemeeter Output (VB-Audio Voicemeeter VAIO)"',
                  ],
                  [
                    "5",
                    'Set PC device above → "Voicemeeter Input (VB-Audio Voicemeeter VAIO)"',
                  ],
                  ["6", "Press a soundboard button — your call will hear it!"],
                ].map(([n, text]) => (
                  <div
                    key={n}
                    style={{
                      display: "flex",
                      gap: 10,
                      marginBottom: 7,
                      fontSize: 12,
                      alignItems: "flex-start",
                    }}
                  >
                    <span
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: "50%",
                        background: "#1a4a1a",
                        color: "#4ade80",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: 10,
                        fontWeight: 700,
                        flexShrink: 0,
                        marginTop: 1,
                      }}
                    >
                      {n}
                    </span>
                    <span style={{ color: "#6aaa6a", lineHeight: 1.5 }}>
                      {text}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
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
              background: "#1a1a1f",
              border: "1px solid #2a2a35",
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
                  background: "#1e1e28",
                  border: "1px solid #2a2a35",
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
                  background: "#2e0d0d",
                  border: "1px solid #5c1a1a",
                  color: "#f87171",
                  cursor: "pointer",
                }}
              >
                Delete
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
  onAudioSettings,
  audioSettingsOpen,
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
        <button
          onClick={onAudioSettings}
          style={{
            ...styles.topBarBtn,
            ...(audioSettingsOpen
              ? {
                  background: "rgba(168,85,247,0.12)",
                  border: "1px solid rgba(168,85,247,0.35)",
                  color: "#c084fc",
                }
              : {}),
          }}
          title="Audio settings"
        >
          <span style={{ fontSize: 11 }}>🎛️</span>
          <span>Audio</span>
        </button>

        <button
          onClick={onPair}
          style={{
            ...styles.topBarBtn,
            ...(pairOpen ? styles.topBarBtnActive : {}),
          }}
        >
          <span style={{ fontSize: 11 }}>📱</span>
          <span>{pairOpen ? "QR Open" : "Connect Phone"}</span>
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
            color: warn ? "#fb923c66" : "#44444e",
            fontSize: 10,
            fontWeight: 600,
          }}
        >
          {label}
        </span>
      )}
      <span
        style={{
          color: warn ? "#fb923c" : "#7a7a8a",
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
      <span style={{ fontSize: 10 }}>
        {muted ? "🔇" : volume > 60 ? "🔊" : "🔉"}
      </span>
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
            width: `${muted ? 0 : volume}%`,
            background: muted ? "#f87171" : volume > 80 ? "#fb923c" : "#4ade80",
            borderRadius: 2,
            transition: "width 0.15s",
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

function Sidebar({
  pages,
  buttons,
  pageButtonCounts,
  currentPage,
  profileRules,
  autoSwitch,
  currentRule,
  activeWindow,
  openWindows,
  showAppPicker,
  captureCountdown,
  onSelectPage,
  onAddPage,
  onDeletePage,
  onToggleAutoSwitch,
  onSaveRule,
  onDeleteRule,
  onSelectRunningApp,
  onPickApp,
  onClosePicker,
  onCaptureDelayed,
  onRefreshCurrentApp,
  addingPage,
  setAddingPage,
  newPageName,
  setNewPageName,
}) {
  const newPageInputRef = useRef();
  useEffect(() => {
    if (addingPage) setTimeout(() => newPageInputRef.current?.focus(), 50);
  }, [addingPage]);

  return (
    <div style={styles.sidebar}>
      {/* Profiles section */}
      <div style={styles.sidebarHeader}>
        <span style={styles.sidebarHeading}>PROFILES</span>
      </div>

      <div style={styles.sidebarList}>
        {pages.map((p) => {
          const rule = profileRules.find((r) => r.page_id === p.id);
          const isActive = p.id === currentPage;
          return (
            <div
              key={p.id}
              style={{
                ...styles.pageItem,
                ...(isActive ? styles.pageItemActive : {}),
              }}
              onClick={() => onSelectPage(p.id)}
            >
              <div
                style={{
                  ...styles.pageItemIconBox,
                  background: isActive ? "rgba(79,128,255,0.18)" : "#1e1e26",
                  border: `1px solid ${isActive ? "rgba(79,128,255,0.35)" : "#2c2c3a"}`,
                }}
              >
                <span style={{ fontSize: 13 }}>🗂</span>
              </div>
              <div style={styles.pageItemInfo}>
                <span
                  style={{
                    ...styles.pageItemName,
                    color: isActive ? "#e8e8f0" : "#9898a8",
                  }}
                >
                  {p.name}
                </span>
                {rule?.enabled && (
                  <span style={styles.pageItemRule}>
                    ⚡ {rule.conditions?.[0]?.value || "rule"}
                  </span>
                )}
              </div>
              <span style={styles.pageItemCount}>
                {p.id === currentPage
                  ? buttons.length
                  : (pageButtonCounts[p.id] ?? 0)}
              </span>
              {pages.length > 1 && (
                <button
                  style={styles.pageDeleteBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDeletePage(p.id);
                  }}
                  title="Delete profile"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}

        {addingPage ? (
          <div style={styles.newPageRow}>
            <input
              ref={newPageInputRef}
              value={newPageName}
              onChange={(e) => setNewPageName(e.target.value)}
              placeholder="Profile name…"
              onKeyDown={(e) => {
                if (e.key === "Enter") onAddPage();
                if (e.key === "Escape") {
                  setAddingPage(false);
                  setNewPageName("");
                }
              }}
              style={{ fontSize: 12, padding: "6px 10px" }}
            />
            <div style={{ display: "flex", gap: 4, marginTop: 6 }}>
              <button
                style={styles.newPageConfirm}
                onClick={onAddPage}
                disabled={!newPageName.trim()}
              >
                Add
              </button>
              <button
                style={styles.newPageCancel}
                onClick={() => {
                  setAddingPage(false);
                  setNewPageName("");
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button style={styles.addPageBtn} onClick={() => setAddingPage(true)}>
            <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
            <span>New Profile</span>
          </button>
        )}
      </div>

      <div style={styles.sidebarDivider} />

      {/* Auto-switch rule editor */}
      {currentPage && (
        <AutoSwitchRuleEditor
          rule={currentRule}
          enabled={autoSwitch}
          activeWindow={activeWindow}
          openWindows={openWindows}
          showAppPicker={showAppPicker}
          captureCountdown={captureCountdown}
          onToggleGlobal={onToggleAutoSwitch}
          onSave={onSaveRule}
          onDelete={onDeleteRule}
          onSelectRunningApp={onSelectRunningApp}
          onPickApp={onPickApp}
          onClosePicker={onClosePicker}
          onCaptureDelayed={onCaptureDelayed}
          onRefreshCurrentApp={onRefreshCurrentApp}
        />
      )}
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
        background: value ? "#3a6fff" : "#252530",
        position: "relative",
        cursor: "pointer",
        transition: "background 0.18s",
        flexShrink: 0,
        border: `1px solid ${value ? "#5a8fff" : "#2c2c3a"}`,
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
  const draft = rule || {
    enabled: false,
    priority: 100,
    logic: "AND",
    conditions: [emptyCondition()],
  };
  const conditions = draft.conditions?.length
    ? draft.conditions
    : [emptyCondition()];
  const patchRule = (patch) => onSave({ ...draft, ...patch });
  const patchCondition = (index, patch) =>
    patchRule({
      conditions: conditions.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    });

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
            style={{ fontSize: 11, color: enabled ? "#7aafff" : "#3a3a50" }}
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
          checked={!!draft.enabled}
          onChange={(e) => patchRule({ enabled: e.target.checked })}
          style={{ cursor: "pointer" }}
        />
        <label style={rs.miniLabel}>Logic</label>
        <select
          style={rs.compactSelect}
          value={draft.logic || "AND"}
          onChange={(e) => patchRule({ logic: e.target.value })}
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
          value={draft.priority ?? 100}
          onChange={(e) => patchRule({ priority: Number(e.target.value) || 0 })}
        />
      </div>

      {/* Conditions */}
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {conditions.map((cond, index) => (
          <div key={index} style={rs.conditionRow}>
            <select
              style={rs.condInput}
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
              style={rs.condInput}
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
                  ? "Code.exe"
                  : cond.type === "window_title"
                    ? "workspace"
                    : "C:\\Path\\App.exe"
              }
              onChange={(e) => patchCondition(index, { value: e.target.value })}
            />
            <button
              style={rs.removeCondBtn}
              onClick={() =>
                patchRule({
                  conditions: conditions.filter((_, i) => i !== index),
                })
              }
              disabled={conditions.length === 1}
              title="Remove condition"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <button
        style={rs.addCondBtn}
        onClick={() =>
          patchRule({ conditions: [...conditions, emptyCondition()] })
        }
      >
        + Add condition
      </button>

      {/* App picker dropdown */}
      {showAppPicker && (
        <div style={rs.picker}>
          <div style={rs.pickerHeader}>
            <span>Running apps</span>
            <button style={rs.pickerClose} onClick={onClosePicker}>
              ✕
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
                onClick={() => onPickApp(app)}
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
  onSelect,
  showLabels,
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: btn.id });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        zIndex: isDragging ? 999 : "auto",
        opacity: isDragging ? 0.3 : 1,
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
  ghost,
  showLabels = true,
}) {
  const isToggleOn =
    Number(btn.is_toggle) === 1 && Number(btn.toggle_state) === 1;
  const isToggle = Number(btn.is_toggle) === 1;
  const isVolumeBtn = VOLUME_ACTIONS.has(btn.action_type);
  const isVideo = btn.icon_data?.startsWith("data:video/");

  const accentColor = btn.color || "#4f80ff";

  return (
    <div
      style={{
        aspectRatio: "1/1",
        borderRadius: 14,
        cursor: "pointer",
        position: "relative",
        overflow: "hidden",
        userSelect: "none",
        // Elgato-style: dark base with subtle top highlight
        background: isToggleOn
          ? `linear-gradient(160deg, ${accentColor}38 0%, ${accentColor}18 100%)`
          : selected
            ? "linear-gradient(160deg, #2a2a38 0%, #1c1c26 100%)"
            : "linear-gradient(160deg, #232330 0%, #181820 100%)",
        border: selected
          ? `1.5px solid #4f80ff`
          : isToggleOn
            ? `1.5px solid ${accentColor}70`
            : "1.5px solid #2c2c3a",
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
          borderRadius: "14px 14px 0 0",
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
          🔊
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
          borderRadius: 14,
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
          <span
            style={{
              fontSize:
                btn.size === "2x2" ? "min(48px,5.5vw)" : "min(34px,3.5vw)",
            }}
          >
            {btn.icon}
          </span>
        )}
      </div>

      {/* Volume fill */}
      {isVolumeBtn && volume !== null && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "flex-end",
            pointerEvents: "none",
            zIndex: 2,
            borderRadius: 14,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              width: "100%",
              height: `${muted ? 0 : volume}%`,
              background: muted
                ? "rgba(248,113,113,0.2)"
                : volume > 80
                  ? "rgba(251,146,60,0.18)"
                  : "rgba(52,211,153,0.12)",
              transition: "height 0.12s",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 8,
              left: 0,
              right: 0,
              textAlign: "center",
              fontSize: 10,
              fontWeight: 700,
              color: muted ? "#f87171" : "#fff",
              textShadow: "0 1px 3px rgba(0,0,0,0.9)",
            }}
          >
            {muted ? "MUTE" : `${volume}%`}
          </div>
        </div>
      )}

      {/* Label */}
      {showLabels && (
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

// ─── Property Panel ───────────────────────────────────────────────────────────

function PropertyPanel({
  btn,
  form,
  saving,
  saved,
  audioDevices,
  onPatch,
  onSave,
  onDelete,
  onUploadIcon,
  onUploadSound,
  onDeleteSound,
}) {
  const iconRef = useRef();
  const soundRef = useRef();

  if (!btn) {
    return (
      <div style={styles.panel}>
        <div style={styles.panelEmpty}>
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: 14,
              background: "linear-gradient(160deg, #232330, #181820)",
              border: "1.5px solid #2c2c3a",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 22,
              marginBottom: 12,
              boxShadow: "0 2px 8px rgba(0,0,0,0.4)",
            }}
          >
            🎛️
          </div>
          <div style={styles.panelEmptyText}>
            Select a button
            <br />
            to configure it
          </div>
          <div style={styles.panelEmptyHint}>Drag buttons to reorder</div>
        </div>
      </div>
    );
  }

  const showActionValue = !VOLUME_NO_VALUE.has(form.action_type);

  return (
    <div style={styles.panel}>
      <div style={styles.panelInner}>
        {/* Preview */}
        <div style={styles.previewRow}>
          <div
            style={{
              width: 68,
              height: 68,
              borderRadius: 14,
              background: `linear-gradient(160deg, ${form.color}28, ${form.color}12)`,
              border: `1.5px solid ${form.color}50`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
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
                  style={{ width: "80%", height: "80%", objectFit: "contain" }}
                />
              ) : (
                <img
                  src={form.icon_data}
                  style={{ width: "80%", height: "80%", objectFit: "contain" }}
                />
              )
            ) : (
              <span>{form.icon}</span>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={styles.previewLabel}>{form.label || "Untitled"}</div>
            <div style={styles.previewAction}>
              {ACTION_LABELS[form.action_type] || form.action_type}
            </div>
          </div>
        </div>

        <div style={styles.panelDivider} />

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
              📁
            </button>
            {form.icon_data && (
              <button
                style={{ ...styles.iconUploadBtn, color: "#f87171" }}
                onClick={() => onPatch({ icon_data: null })}
                title="Remove image"
              >
                ✕
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
                  width: 22,
                  height: 22,
                  borderRadius: 6,
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
              value={form.color || "#5B4FCF"}
              onChange={(e) => onPatch({ color: e.target.value })}
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

        <div style={styles.panelDivider} />

        {/* Action type */}
        <Field label="Action">
          <select
            value={form.action_type || "keystroke"}
            onChange={(e) =>
              onPatch({ action_type: e.target.value, action_value: "" })
            }
          >
            {ACTION_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.types.map((t) => (
                  <option key={t} value={t}>
                    {ACTION_LABELS[t]}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </Field>

        {/* Action value */}
        {showActionValue && (
          <Field
            label={
              form.action_type === "audio_switch_device" ? "Device" : "Value"
            }
          >
            {form.action_type === "audio_switch_device" ? (
              <select
                value={form.action_value || ""}
                onChange={(e) => onPatch({ action_value: e.target.value })}
              >
                <option value="">— select device —</option>
                {audioDevices.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                    {d.isDefault ? " ✓" : ""}
                  </option>
                ))}
              </select>
            ) : form.action_type === "launch" ? (
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  value={form.action_value || ""}
                  onChange={(e) => onPatch({ action_value: e.target.value })}
                  placeholder="C:\path\to\app.exe"
                  style={{ flex: 1 }}
                />
                <button
                  style={styles.iconUploadBtn}
                  onClick={async () => {
                    try {
                      const path = await window.electronAPI?.system.pickFile();
                      if (path) onPatch({ action_value: path });
                    } catch {
                      /* ignore */
                    }
                  }}
                >
                  📁
                </button>
              </div>
            ) : (
              <input
                value={form.action_value || ""}
                onChange={(e) => onPatch({ action_value: e.target.value })}
                placeholder={
                  form.action_type === "volume_set"
                    ? "0–100"
                    : form.action_type === "url"
                      ? "https://..."
                      : "value"
                }
              />
            )}
          </Field>
        )}

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
          <Field label="Toggle OFF action">
            <input
              value={form.toggle_action_value || ""}
              onChange={(e) => onPatch({ toggle_action_value: e.target.value })}
              placeholder="Action when toggling off"
            />
          </Field>
        ) : null}

        <div style={styles.panelDivider} />

        {/* Sound */}
        <Field label="Button sound">
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {form.sound_file ? (
              <div style={{ display: "flex", gap: 6 }}>
                <div style={styles.soundChip}>🔊 Sound attached</div>
                <button
                  style={{ ...styles.iconUploadBtn, color: "#f87171" }}
                  onClick={onDeleteSound}
                  title="Remove sound"
                >
                  ✕
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
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </Field>

        <div style={styles.panelDivider} />

        {/* Save / Delete */}
        <div style={styles.panelActions}>
          <button style={styles.saveBtn} onClick={onSave} disabled={saving}>
            {saving ? "Saving…" : saved ? "✓ Saved" : "Save Changes"}
          </button>
          <button style={styles.deleteBtn} onClick={onDelete}>
            Delete
          </button>
        </div>
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

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    background: "#13131a",
    fontFamily: "'DM Sans', system-ui, sans-serif",
    color: "#c8c8d4",
    overflow: "hidden",
  },

  // ── Top bar ──
  topBar: {
    display: "flex",
    alignItems: "center",
    padding: "0 16px",
    height: 48,
    flexShrink: 0,
    background: "#0f0f14",
    borderBottom: "1px solid #1e1e28",
    gap: 10,
  },
  topBarLogo: { display: "flex", alignItems: "center", gap: 8, marginRight: 2 },
  logoDivider: { width: 1, height: 20, background: "#2a2a36", marginLeft: 8 },
  logoText: {
    fontWeight: 700,
    fontSize: 13,
    color: "#e0e0ec",
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
    border: "1px solid #2c2c3a",
    borderRadius: 8,
    color: "#8888a0",
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
    background: "#1a1a22",
    border: "1px solid #252530",
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

  // ── Sidebar ──
  sidebar: {
    width: 272,
    flexShrink: 0,
    background: "#0f0f14",
    borderRight: "1px solid #1e1e28",
    display: "flex",
    flexDirection: "column",
    overflowY: "auto",
  },
  sidebarHeader: { padding: "16px 14px 8px" },
  sidebarList: { padding: "0 8px 8px" },
  sidebarSection: { padding: "0 14px 12px" },
  sidebarHeading: {
    fontSize: 10,
    fontWeight: 700,
    color: "#3a3a4e",
    letterSpacing: 1.4,
    textTransform: "uppercase",
  },
  sidebarDivider: { height: 1, background: "#1e1e28", margin: "4px 0" },

  pageItem: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "7px 8px",
    borderRadius: 9,
    cursor: "pointer",
    transition: "background 0.1s",
    marginBottom: 1,
  },
  pageItemActive: {
    background: "rgba(79,128,255,0.1)",
    border: "none",
  },
  pageItemIconBox: {
    width: 28,
    height: 28,
    borderRadius: 7,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    transition: "background 0.1s, border 0.1s",
  },
  pageItemInfo: { flex: 1, minWidth: 0 },
  pageItemName: {
    fontSize: 12,
    fontWeight: 600,
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    transition: "color 0.1s",
  },
  pageItemRule: {
    fontSize: 10,
    color: "#3a3a50",
    display: "block",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: 1,
  },
  pageItemCount: {
    fontSize: 10,
    color: "#3a3a50",
    flexShrink: 0,
    fontWeight: 600,
    minWidth: 12,
    textAlign: "right",
  },
  pageDeleteBtn: {
    background: "none",
    border: "none",
    color: "#3a3a50",
    cursor: "pointer",
    fontSize: 9,
    padding: "2px 4px",
    borderRadius: 4,
    flexShrink: 0,
    transition: "color 0.1s",
  },
  addPageBtn: {
    width: "100%",
    padding: "7px 10px",
    marginTop: 4,
    background: "none",
    border: "1px dashed #252530",
    borderRadius: 8,
    color: "#3a3a50",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    transition: "all 0.12s",
    display: "flex",
    alignItems: "center",
    gap: 6,
    justifyContent: "center",
  },
  newPageRow: { padding: "4px 2px 6px" },
  newPageConfirm: {
    flex: 1,
    padding: "5px 10px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 700,
    background: "rgba(79,128,255,0.2)",
    border: "1px solid rgba(79,128,255,0.4)",
    color: "#7aafff",
    cursor: "pointer",
  },
  newPageCancel: {
    flex: 1,
    padding: "5px 10px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 600,
    background: "#1a1a22",
    border: "1px solid #2c2c3a",
    color: "#5a5a70",
    cursor: "pointer",
  },
  autoSwitchRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  autoSwitchLabel: { fontSize: 12, color: "#5a5a70" },
  ruleChip: {
    background: "#0a180e",
    border: "1px solid #1a3a22",
    borderRadius: 8,
    padding: "7px 10px",
  },

  // ── Center grid ──
  center: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0,
    background: "#13131a",
    overflow: "hidden",
  },
  gridHeader: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "12px 18px 10px",
    borderBottom: "1px solid #1e1e28",
    flexShrink: 0,
    background: "#111118",
  },
  gridTitle: { fontWeight: 700, fontSize: 13, color: "#e0e0ec" },
  gridCount: { fontSize: 11, color: "#3a3a50", fontWeight: 500 },
  addBtnPill: {
    marginLeft: "auto",
    background: "rgba(79,128,255,0.14)",
    border: "1px solid rgba(79,128,255,0.3)",
    borderRadius: 8,
    padding: "5px 13px",
    color: "#7aafff",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    transition: "all 0.12s",
  },
  grid: {
    flex: 1,
    padding: 18,
    overflowY: "auto",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))",
    gridAutoRows: "minmax(108px, calc((100% - 36px - 10px * 5) / 5))",
    gap: 15,
    alignContent: "start",
  },
  addSlot: {
    aspectRatio: "1/1",
    borderRadius: 14,
    border: "1.5px dashed #252530",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    cursor: "pointer",
    transition: "all 0.12s",
    background: "transparent",
  },
  addSlotPlus: {
    fontSize: 22,
    color: "#2c2c3c",
    fontWeight: 300,
    lineHeight: 1,
  },

  // ── Property panel ──
  panel: {
    width: 262,
    flexShrink: 0,
    background: "#0f0f14",
    borderLeft: "1px solid #1e1e28",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  panelInner: {
    padding: "14px 14px",
    display: "flex",
    flexDirection: "column",
    gap: 1,
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
    fontSize: 12,
    color: "#44444e",
    textAlign: "center",
    lineHeight: 1.7,
  },
  panelEmptyHint: {
    fontSize: 10,
    color: "#2a2a38",
    textAlign: "center",
    marginTop: 4,
  },
  panelDivider: { height: 1, background: "#1e1e28", margin: "10px 0" },

  previewRow: {
    display: "flex",
    gap: 12,
    alignItems: "center",
    marginBottom: 6,
  },
  previewLabel: {
    fontSize: 14,
    fontWeight: 700,
    color: "#e0e0ec",
    marginBottom: 2,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  previewAction: { fontSize: 11, color: "#44444e" },

  field: { marginBottom: 9 },
  fieldLabel: {
    display: "block",
    fontSize: 10,
    fontWeight: 700,
    color: "#3a3a50",
    letterSpacing: 1,
    marginBottom: 5,
    textTransform: "uppercase",
  },

  segBtn: {
    padding: "5px 11px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 600,
    background: "#1a1a22",
    border: "1px solid #2c2c3a",
    color: "#55556a",
    cursor: "pointer",
    transition: "all 0.1s",
  },
  segBtnActive: {
    background: "rgba(79,128,255,0.15)",
    border: "1px solid rgba(79,128,255,0.4)",
    color: "#7aafff",
  },

  iconUploadBtn: {
    width: 30,
    height: 30,
    borderRadius: 7,
    background: "#1a1a22",
    border: "1px solid #2c2c3a",
    color: "#7a7a8a",
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
    background: "#1a1a22",
    border: "1px dashed #2c2c3a",
    color: "#55556a",
    cursor: "pointer",
    transition: "all 0.12s",
  },

  panelActions: { display: "flex", gap: 8, marginTop: 6 },
  saveBtn: {
    flex: 1,
    padding: "9px 16px",
    borderRadius: 8,
    fontSize: 12,
    fontWeight: 700,
    background: "linear-gradient(135deg, #3a6fff, #5b8fff)",
    border: "none",
    color: "#fff",
    cursor: "pointer",
    boxShadow: "0 2px 12px rgba(79,128,255,0.3)",
    transition: "opacity 0.12s",
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
    background: "#111118",
    border: "1px solid #1e1e2c",
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
    color: "#7aafff",
    marginBottom: 2,
    letterSpacing: 0.3,
  },
  meta: {
    fontSize: 10,
    color: "#3a3a58",
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
    background: "#1a1a26",
    border: "1px solid #2c2c3a",
    borderRadius: 6,
    color: "#8888a8",
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
    color: "#44445a",
    fontWeight: 700,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  compactSelect: {
    background: "#1a1a26",
    border: "1px solid #2c2c3a",
    borderRadius: 6,
    color: "#c8c8d4",
    padding: "4px 6px",
    fontSize: 11,
    outline: "none",
    fontFamily: "'DM Sans', system-ui, sans-serif",
    boxSizing: "border-box",
  },
  compactInput: {
    background: "#1a1a26",
    border: "1px solid #2c2c3a",
    borderRadius: 6,
    color: "#c8c8d4",
    padding: "4px 6px",
    fontSize: 11,
    outline: "none",
    width: 52,
    boxSizing: "border-box",
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  conditionRow: {
    display: "grid",
    gridTemplateColumns: "80px 80px 1fr 2px",
    gap: 4,
    alignItems: "center",
    width: "100%",
  },
  condInput: {
    background: "#1a1a26",
    border: "1px solid #2c2c3a",
    borderRadius: 6,
    color: "#c8c8d4",
    padding: "5px 6px",
    fontSize: 11,
    outline: "none",
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  removeCondBtn: {
    background: "none",
    border: "none",
    color: "#3a3a50",
    cursor: "pointer",
    fontSize: 9,
    padding: "2px 4px",
    flexShrink: 0,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  addCondBtn: {
    alignSelf: "flex-start",
    background: "none",
    border: "1px dashed #2c2c3a",
    borderRadius: 6,
    color: "#44445a",
    cursor: "pointer",
    padding: "4px 8px",
    fontSize: 10,
    fontWeight: 600,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  picker: {
    borderRadius: 8,
    border: "1px solid #2c2c3a",
    background: "#0d0d12",
    overflow: "hidden",
  },
  pickerHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "7px 10px",
    borderBottom: "1px solid #1e1e28",
    color: "#c8c8d4",
    fontSize: 11,
    fontWeight: 700,
  },
  pickerClose: {
    background: "none",
    border: "none",
    color: "#44445a",
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
    borderBottom: "1px solid #1a1a22",
    color: "#c8c8d4",
    cursor: "pointer",
    padding: "7px 10px",
    fontFamily: "'DM Sans', system-ui, sans-serif",
  },
  pickerProcess: {
    fontSize: 11,
    fontWeight: 700,
    color: "#7aafff",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pickerTitle: {
    fontSize: 11,
    color: "#9898a8",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  pickerPath: {
    gridColumn: "1 / -1",
    fontSize: 9,
    color: "#3a3a50",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    marginTop: 1,
  },
  pickerEmpty: { padding: 10, fontSize: 11, color: "#3a3a50" },
};

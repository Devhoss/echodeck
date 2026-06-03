import { useCallback, useEffect, useRef, useState } from "react";
import { API } from "./constants.js";

const ACTION_GROUPS = [
  { label: "General", types: ["keystroke", "type", "shell", "url", "launch"] },
  {
    label: "Volume",
    types: ["volume_up", "volume_down", "volume_set", "volume_mute"],
  },
  { label: "Audio", types: ["audio_switch_device"] },
];

const COLORS = [
  "#5B4FCF",
  "#0F6E56",
  "#185FA5",
  "#854F0B",
  "#7C1D3F",
  "#1D5C7C",
  "#2D6B2D",
  "#6B2D2D",
];

const emptyStep = () => ({
  action_type: "keystroke",
  action_value: "",
  delay_ms: 0,
});
const VOLUME_NO_VALUE = new Set(["volume_mute", "volume_up", "volume_down"]);
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

// FEATURE: Soundboard routing — 3-way options
const SOUND_TARGETS = [
  { value: "phone", label: "📱 Phone only", desc: "You hear it" },
  { value: "pc", label: "🖥️ PC only", desc: "Call hears it" },
  { value: "both", label: "📱+🖥️ Both", desc: "Everyone hears it" },
];

export default function ConfigUI({ onBack }) {
  const [pages, setPages] = useState([]);
  const [activePage, setActivePage] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [audioDevices, setAudioDevices] = useState([]);
  // FEATURE: Settings panel
  const [showSettings, setShowSettings] = useState(false);
  const [pcSoundDevice, setPcSoundDevice] = useState("");
  const [autoSwitchEnabled, setAutoSwitchEnabled] = useState(true);
  const [profileRules, setProfileRules] = useState([]);
  const [activeWindow, setActiveWindow] = useState(null);
  const [openWindows, setOpenWindows] = useState([]);
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [captureCountdown, setCaptureCountdown] = useState(0);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const captureTimerRef = useRef(null);
  const abortRef = useRef(null);

  useEffect(() => {
    loadPages();
    loadAudioDevices();
    loadSettings();
    loadProfileRules();
    return () => clearInterval(captureTimerRef.current);
  }, []);

  async function loadSettings() {
    try {
      const res = await fetch(`${API}/settings`);
      const data = await res.json();
      setPcSoundDevice(data.pc_sound_device ?? "");
      setAutoSwitchEnabled(data.auto_profile_switching !== false);
    } catch {
      /* ignore */
    }
  }

  async function saveSettings() {
    await fetch(`${API}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "pc_sound_device", value: pcSoundDevice }),
    });
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2000);
  }

  async function saveAutoSwitchEnabled(enabled) {
    setAutoSwitchEnabled(enabled);
    await fetch(`${API}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "auto_profile_switching", value: enabled }),
    });
  }

  async function loadProfileRules() {
    try {
      const res = await fetch(`${API}/profile-rules`);
      setProfileRules(await res.json());
    } catch {
      setProfileRules([]);
    }
  }

  async function getCurrentApp() {
    const res = await fetch(`${API}/active-window`);
    const data = await res.json();
    setActiveWindow(data);
    return data;
  }

  async function loadOpenWindows() {
    const res = await fetch(`${API}/open-windows`);
    const data = await res.json();
    setOpenWindows(Array.isArray(data) ? data : []);
    setShowAppPicker(true);
  }

  async function saveAppAsRule(app) {
    await saveProfileRule({
      enabled: true,
      logic: "AND",
      conditions: [
        {
          type: "process",
          operator: "equals",
          value: app.process || "",
        },
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
      await saveAppAsRule(app);
    }, 1000);
  }

  async function loadAudioDevices() {
    try {
      const res = await fetch(`${API}/audio-devices`);
      setAudioDevices(await res.json());
    } catch {
      setAudioDevices([]);
    }
  }

  async function loadPages() {
    abortRef.current?.abort();
    abortRef.current = new AbortController();
    try {
      const res = await fetch(`${API}/pages`, {
        signal: abortRef.current.signal,
      });
      const data = await res.json();
      setPages(data);
      setActivePage((prev) => prev ?? data[0]?.id ?? null);
    } catch (e) {
      if (e.name !== "AbortError") console.error(e);
    }
  }

  const currentPage = pages.find((p) => p.id === activePage);
  const currentRule = profileRules.find((r) => r.page_id === activePage);
  const patchForm = useCallback(
    (patch) => setForm((f) => ({ ...f, ...patch })),
    [],
  );

  async function saveProfileRule(rulePatch) {
    if (!activePage) return;
    const nextRule = {
      page_id: activePage,
      enabled: true,
      priority: 100,
      logic: "AND",
      conditions: [emptyCondition()],
      ...(currentRule || {}),
      ...rulePatch,
    };
    const endpoint = currentRule
      ? `${API}/profile-rules/${currentRule.id}`
      : `${API}/profile-rules`;
    const method = currentRule ? "PATCH" : "POST";
    await fetch(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(nextRule),
    });
    await loadProfileRules();
  }

  async function deleteProfileRule() {
    if (!currentRule) return;
    await fetch(`${API}/profile-rules/${currentRule.id}`, { method: "DELETE" });
    await loadProfileRules();
  }

  async function addPage() {
    const name = prompt("Page name:");
    if (!name) return;
    await fetch(`${API}/pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    await loadPages();
  }

  async function deletePage(id) {
    if (!confirm("Delete this page and all its buttons?")) return;
    await fetch(`${API}/pages/${id}`, { method: "DELETE" });
    setActivePage(pages.find((p) => p.id !== id)?.id || null);
    await loadPages();
  }

  async function addButton() {
    await fetch(`${API}/buttons`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page_id: activePage }),
    });
    await loadPages();
  }

  async function saveButton() {
    setSaving(true);
    await fetch(`${API}/buttons/${editing}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    setSaving(false);
    setEditing(null);
    await loadPages();
  }

  async function deleteButton(id) {
    if (!confirm("Delete this button?")) return;
    await fetch(`${API}/buttons/${id}`, { method: "DELETE" });
    setEditing(null);
    await loadPages();
  }

  function startEdit(btn) {
    setEditing(btn.id);
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
  }

  const s = styles;

  // FEATURE: Settings panel overlay
  if (showSettings) {
    return (
      <div style={s.root}>
        <div style={s.header}>
          <button
            style={s.backBtn}
            onMouseDown={(e) => {
              e.preventDefault();
              setShowSettings(false);
            }}
          >
            ← Back
          </button>
          <span style={{ fontWeight: 700, fontSize: 15 }}>⚙ Settings</span>
        </div>
        <div style={{ padding: 24, maxWidth: 480 }}>
          {/* PC Sound Device */}
          <div
            style={{
              background: "#1a0a2e",
              border: "1px solid #3b1a5c",
              borderRadius: 12,
              padding: 16,
              marginBottom: 20,
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
              This is the audio device ffplay will use when playing sounds to
              your PC. Set it to your{" "}
              <strong style={{ color: "#a855f7" }}>Voicemeeter Input</strong> so
              Discord (or any app) can hear the soundboard.
              <br />
              <br />
              In Discord: Settings → Voice → Input Device →{" "}
              <strong style={{ color: "#a855f7" }}>
                Voicemeeter Output (VB-Audio Voicemeeter VAIO)
              </strong>
            </div>

            <label style={{ ...s.label, color: "#c084fc" }}>Device name</label>
            {audioDevices.length > 0 ? (
              <select
                style={s.input}
                value={pcSoundDevice}
                onChange={(e) => setPcSoundDevice(e.target.value)}
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
                  style={{ fontSize: 11, color: "#5a3080", marginBottom: 8 }}
                >
                  No devices auto-detected. Enter the exact device name as shown
                  in Windows Sound settings.
                </div>
                <input
                  style={s.input}
                  value={pcSoundDevice}
                  onChange={(e) => setPcSoundDevice(e.target.value)}
                  placeholder="Voicemeeter Input (VB-Audio Voicemeeter VAIO)"
                />
              </>
            )}

            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <button style={s.saveBtn} onClick={saveSettings}>
                {settingsSaved ? "✓ Saved!" : "Save"}
              </button>
              <button
                style={{ ...s.cancelBtn, fontSize: 11, padding: "6px 10px" }}
                onClick={loadAudioDevices}
              >
                ↺ Refresh devices
              </button>
            </div>
          </div>

          {/* How to set up Voicemeeter */}
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
              🎙️ Voicemeeter Banana setup guide
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
                  marginBottom: 8,
                  fontSize: 12,
                  color: "#4a7a4a",
                }}
              >
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: "50%",
                    background: "#1a4a1a",
                    color: "#4ade80",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                    fontWeight: 700,
                    flexShrink: 0,
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
    );
  }

  return (
    <div style={s.root}>
      <div style={s.header}>
        <button
          onMouseDown={(e) => {
            e.preventDefault();
            onBack();
          }}
          style={s.backBtn}
        >
          ← Back
        </button>
        <span style={{ fontWeight: 700, fontSize: 15 }}>Config</span>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>
          {pages.reduce((a, p) => a + (p.buttons?.length || 0), 0)} buttons
        </span>
        {/* FEATURE: Settings — gear button opens settings panel */}
        <button
          style={{
            ...s.backBtn,
            marginLeft: 8,
            borderColor: "#3b1a5c",
            color: "#c084fc",
          }}
          onMouseDown={(e) => {
            e.preventDefault();
            setShowSettings(true);
          }}
        >
          ⚙ Audio
        </button>
      </div>

      <div style={s.body}>
        {/* Pages sidebar */}
        <div style={s.sidebar}>
          <div style={s.sidebarLabel}>PAGES</div>
          {pages.map((p) => (
            <div
              key={p.id}
              style={{
                ...s.pageItem,
                ...(activePage === p.id ? s.pageItemActive : {}),
              }}
              onClick={() => setActivePage(p.id)}
            >
              <span style={{ flex: 1 }}>{p.name}</span>
              <span style={{ fontSize: 10, color: "#555" }}>
                {p.buttons?.length || 0}
              </span>
              {pages.length > 1 && (
                <button
                  style={s.iconBtn}
                  onClick={(e) => {
                    e.stopPropagation();
                    deletePage(p.id);
                  }}
                >
                  ✕
                </button>
              )}
            </div>
          ))}
          <button style={s.addPageBtn} onClick={addPage}>
            + Add Page
          </button>
        </div>

        {/* Button list */}
        <div style={s.buttonList}>
          <div style={s.listHeader}>
            <span style={{ fontWeight: 600 }}>{currentPage?.name}</span>
            <button style={s.addBtn} onClick={addButton}>
              + Add Button
            </button>
          </div>
          {currentPage && (
            <AutoSwitchRuleEditor
              rule={currentRule}
              enabled={autoSwitchEnabled}
              activeWindow={activeWindow}
              openWindows={openWindows}
              showAppPicker={showAppPicker}
              captureCountdown={captureCountdown}
              onToggleGlobal={saveAutoSwitchEnabled}
              onSave={saveProfileRule}
              onDelete={deleteProfileRule}
              onSelectRunningApp={loadOpenWindows}
              onPickApp={saveAppAsRule}
              onClosePicker={() => setShowAppPicker(false)}
              onCaptureDelayed={startDelayedCapture}
              onRefreshCurrentApp={getCurrentApp}
            />
          )}
          {currentPage?.buttons?.map((btn) => (
            <div
              key={btn.id}
              style={{
                ...s.btnRow,
                ...(editing === btn.id ? s.btnRowActive : {}),
              }}
              onClick={() => startEdit(btn)}
            >
              <div
                style={{
                  ...s.colorDot,
                  background: btn.color,
                  overflow: "hidden",
                }}
              >
                {btn.icon_data ? (
                  <img
                    src={btn.icon_data}
                    style={{
                      width: "100%",
                      height: "100%",
                      objectFit: "cover",
                    }}
                  />
                ) : (
                  btn.icon
                )}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontWeight: 600,
                    fontSize: 13,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {btn.label}
                  {btn.size === "2x2" && (
                    <Badge color="#6c63ff" bg="#1e1a3a">
                      2×2
                    </Badge>
                  )}
                  {!!btn.is_toggle && (
                    <Badge color="#0F6E56" bg="#0a2318">
                      toggle
                    </Badge>
                  )}
                  {btn.actions?.length > 0 && (
                    <Badge color="#854F0B" bg="#2a1800">
                      {btn.actions.length} steps
                    </Badge>
                  )}
                  {btn.action_type?.startsWith("volume_") && (
                    <Badge color="#3b82f6" bg="#0a1a2e">
                      vol
                    </Badge>
                  )}
                  {btn.action_type === "audio_switch_device" && (
                    <Badge color="#a855f7" bg="#1a0a2e">
                      out
                    </Badge>
                  )}
                  {btn.sound_file && (
                    <Badge color="#f59e0b" bg="#2a1800">
                      {btn.sound_target === "pc"
                        ? "🖥️🔊"
                        : btn.sound_target === "both"
                          ? "📱+🖥️🔊"
                          : "📱🔊"}
                    </Badge>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "#555",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {btn.action_type}: {btn.action_value || "—"}
                </div>
              </div>
              <span style={{ fontSize: 11, color: "#444", flexShrink: 0 }}>
                Edit →
              </span>
            </div>
          ))}
          {!currentPage?.buttons?.length && (
            <div
              style={{
                padding: 32,
                textAlign: "center",
                color: "#444",
                fontSize: 13,
              }}
            >
              No buttons yet. Click + Add Button.
            </div>
          )}
        </div>

        {/* Edit panel */}
        {editing && (
          <div style={s.editPanel}>
            <div style={s.editHeader}>Edit Button</div>

            <label style={s.label}>Label</label>
            <input
              style={s.input}
              value={form.label}
              onChange={(e) => patchForm({ label: e.target.value })}
            />

            <label style={s.label}>Icon</label>
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                marginBottom: 16,
              }}
            >
              <input
                style={{
                  ...s.input,
                  marginBottom: 0,
                  width: 64,
                  textAlign: "center",
                  fontSize: 20,
                  flexShrink: 0,
                }}
                value={form.icon}
                onChange={(e) =>
                  patchForm({ icon: e.target.value, icon_data: null })
                }
                placeholder="⚡"
              />
              <span style={{ color: "#444", fontSize: 11, flexShrink: 0 }}>
                or
              </span>
              <label style={s.uploadLabel}>
                {form.icon_data ? (
                  <>
                    <img
                      src={form.icon_data}
                      style={{
                        width: 20,
                        height: 20,
                        borderRadius: 4,
                        objectFit: "cover",
                      }}
                    />{" "}
                    Change
                  </>
                ) : (
                  <>📁 Upload</>
                )}
                <input
                  type="file"
                  accept="image/*,video/*"
                  style={{ display: "none" }}
                  onChange={async (e) => {
                    const file = e.target.files[0];
                    if (!file || !editing) return;
                    const res = await fetch(`${API}/buttons/${editing}/icon`, {
                      method: "POST",
                      headers: { "Content-Type": file.type },
                      body: file,
                    });
                    patchForm({ icon_data: (await res.json()).icon_data });
                    await loadPages();
                  }}
                />
              </label>
              {form.icon_data && (
                <button
                  style={{ ...s.cancelBtn, padding: "7px 10px", flexShrink: 0 }}
                  onClick={() => {
                    patchForm({ icon_data: null });
                    fetch(`${API}/buttons/${editing}`, {
                      method: "PATCH",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ icon_data: null }),
                    }).then(() => loadPages());
                  }}
                >
                  ✕
                </button>
              )}
            </div>

            <label style={s.label}>Color</label>
            <div
              style={{
                display: "flex",
                gap: 8,
                flexWrap: "wrap",
                marginBottom: 16,
              }}
            >
              {COLORS.map((c) => (
                <div
                  key={c}
                  onClick={() => patchForm({ color: c })}
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: 6,
                    background: c,
                    cursor: "pointer",
                    outline: form.color === c ? "2px solid #fff" : "none",
                    outlineOffset: 2,
                  }}
                />
              ))}
              <input
                type="color"
                value={form.color}
                onChange={(e) => patchForm({ color: e.target.value })}
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                }}
              />
            </div>

            <label style={s.label}>Button Size</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
              {["1x1", "2x2"].map((sz) => (
                <div
                  key={sz}
                  onClick={() => patchForm({ size: sz })}
                  style={{
                    flex: 1,
                    borderRadius: 10,
                    padding: 10,
                    cursor: "pointer",
                    border: `2px solid ${form.size === sz ? "#6c63ff" : "#2a2a35"}`,
                    background: form.size === sz ? "#1e1a3a" : "#1a1a22",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: sz === "2x2" ? "1fr 1fr" : "1fr",
                      gap: 3,
                    }}
                  >
                    {Array.from({ length: sz === "2x2" ? 4 : 1 }).map(
                      (_, i) => (
                        <div
                          key={i}
                          style={{
                            width: sz === "2x2" ? 10 : 18,
                            height: sz === "2x2" ? 10 : 18,
                            borderRadius: 3,
                            background: form.size === sz ? "#6c63ff" : "#333",
                          }}
                        />
                      ),
                    )}
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      color: form.size === sz ? "#a89fff" : "#555",
                      fontWeight: 600,
                    }}
                  >
                    {sz}
                  </span>
                </div>
              ))}
            </div>

            <label
              style={{
                ...s.label,
                display: "flex",
                alignItems: "center",
                gap: 6,
                cursor: "pointer",
              }}
            >
              <input
                type="checkbox"
                checked={!!form.is_toggle}
                onChange={(e) =>
                  patchForm({ is_toggle: e.target.checked ? 1 : 0 })
                }
              />
              Toggle Button (two-state)
            </label>
            {!!form.is_toggle && (
              <div
                style={{
                  background: "#0a2318",
                  border: "1px solid #1a5c32",
                  borderRadius: 10,
                  padding: 12,
                  marginBottom: 16,
                  marginTop: 8,
                }}
              >
                <div
                  style={{
                    fontSize: 11,
                    color: "#4ade80",
                    fontWeight: 600,
                    marginBottom: 10,
                  }}
                >
                  ↑ ON action · ↓ OFF action
                </div>
                <label style={{ ...s.label, color: "#4ade80" }}>
                  OFF → ON type
                </label>
                <ActionTypeSelect
                  value={form.action_type}
                  onChange={(v) => patchForm({ action_type: v })}
                  style={s.input}
                />
                <label style={{ ...s.label, color: "#4ade80" }}>
                  OFF → ON value
                </label>
                <input
                  style={s.input}
                  value={form.action_value}
                  onChange={(e) => patchForm({ action_value: e.target.value })}
                  placeholder={actionPlaceholder(form.action_type)}
                />
                <label style={{ ...s.label, color: "#f87171" }}>
                  ON → OFF type
                </label>
                <ActionTypeSelect
                  value={form.toggle_action_type}
                  onChange={(v) => patchForm({ toggle_action_type: v })}
                  style={s.input}
                />
                <label style={{ ...s.label, color: "#f87171" }}>
                  ON → OFF value
                </label>
                <input
                  style={{ ...s.input, marginBottom: 0 }}
                  value={form.toggle_action_value}
                  onChange={(e) =>
                    patchForm({ toggle_action_value: e.target.value })
                  }
                  placeholder={actionPlaceholder(form.toggle_action_type)}
                />
              </div>
            )}

            {!form.is_toggle && !(form.actions?.length > 0) && (
              <>
                <label style={s.label}>Action Type</label>
                <ActionTypeSelect
                  value={form.action_type}
                  onChange={(v) => patchForm({ action_type: v })}
                  style={s.input}
                />

                {form.action_type === "volume_mute" && (
                  <div style={s.infoBox}>
                    🔇 Toggles mute on/off — no value needed.
                  </div>
                )}
                {(form.action_type === "volume_up" ||
                  form.action_type === "volume_down") && (
                  <div style={s.sliderBox}>
                    <label style={{ ...s.label, color: "#60a5fa" }}>
                      Step size (1–20%)
                    </label>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <input
                        type="range"
                        min="1"
                        max="20"
                        value={parseInt(form.action_value) || 5}
                        onChange={(e) =>
                          patchForm({ action_value: e.target.value })
                        }
                        style={{ flex: 1, accentColor: "#3b82f6" }}
                      />
                      <span style={s.sliderVal}>
                        {parseInt(form.action_value) || 5}%
                      </span>
                    </div>
                    <div
                      style={{ fontSize: 11, color: "#3b5a8a", marginTop: 6 }}
                    >
                      Hold the button to adjust continuously.
                    </div>
                  </div>
                )}
                {form.action_type === "volume_set" && (
                  <div style={s.sliderBox}>
                    <label style={{ ...s.label, color: "#60a5fa" }}>
                      Target volume (0–100%)
                    </label>
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 8 }}
                    >
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={parseInt(form.action_value) || 50}
                        onChange={(e) =>
                          patchForm({ action_value: e.target.value })
                        }
                        style={{ flex: 1, accentColor: "#3b82f6" }}
                      />
                      <span style={s.sliderVal}>
                        {parseInt(form.action_value) || 50}%
                      </span>
                    </div>
                  </div>
                )}
                {form.action_type === "audio_switch_device" && (
                  <div
                    style={{
                      background: "#1a0a2e",
                      border: "1px solid #3b1a5c",
                      borderRadius: 10,
                      padding: 12,
                      marginBottom: 16,
                    }}
                  >
                    <label style={{ ...s.label, color: "#c084fc" }}>
                      Output Device
                    </label>
                    {audioDevices.length > 0 ? (
                      <select
                        style={{ ...s.input, marginBottom: 8 }}
                        value={form.action_value}
                        onChange={(e) =>
                          patchForm({ action_value: e.target.value })
                        }
                      >
                        <option value="">— select device —</option>
                        {audioDevices.map((d) => (
                          <option key={d.id} value={d.name}>
                            {d.name}
                            {d.isDefault ? " ✓" : ""}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        style={s.input}
                        value={form.action_value}
                        onChange={(e) =>
                          patchForm({ action_value: e.target.value })
                        }
                        placeholder="e.g. Speakers (Realtek)"
                      />
                    )}
                    <button
                      style={{
                        ...s.cancelBtn,
                        fontSize: 11,
                        padding: "4px 10px",
                      }}
                      onClick={loadAudioDevices}
                    >
                      ↺ Refresh
                    </button>
                  </div>
                )}
                {!form.action_type?.startsWith("volume_") &&
                  form.action_type !== "audio_switch_device" && (
                    <>
                      <label style={s.label}>
                        {actionLabel(form.action_type)}
                      </label>
                      <div
                        style={{ display: "flex", gap: 6, marginBottom: 16 }}
                      >
                        <input
                          style={{ ...s.input, marginBottom: 0, flex: 1 }}
                          value={form.action_value}
                          onChange={(e) =>
                            patchForm({ action_value: e.target.value })
                          }
                          placeholder={actionPlaceholder(form.action_type)}
                        />
                        {form.action_type === "launch" && (
                          <button
                            style={s.browseBtn}
                            onClick={async () => {
                              const res = await fetch(`${API}/pick-file`);
                              const data = await res.json();
                              if (data.path)
                                patchForm({ action_value: data.path });
                            }}
                          >
                            📁
                          </button>
                        )}
                      </div>
                    </>
                  )}
              </>
            )}

            {/* Multi-action */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <label style={{ ...s.label, marginBottom: 0 }}>
                Multi-Action Steps
              </label>
              <button
                style={{ ...s.addBtn, padding: "3px 10px", fontSize: 11 }}
                onClick={() =>
                  patchForm({
                    actions: [...(form.actions || []), emptyStep()],
                    is_toggle: 0,
                  })
                }
              >
                + Add Step
              </button>
            </div>
            {form.actions?.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginBottom: 16,
                }}
              >
                {form.actions.map((step, i) => (
                  <div
                    key={i}
                    style={{
                      background: "#1a1a22",
                      border: "1px solid #2a2a35",
                      borderRadius: 10,
                      padding: 10,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 6,
                      }}
                    >
                      <span
                        style={{ fontSize: 11, color: "#555", fontWeight: 600 }}
                      >
                        Step {i + 1}
                      </span>
                      <button
                        style={{
                          background: "none",
                          border: "none",
                          color: "#ef4444",
                          cursor: "pointer",
                          fontSize: 12,
                        }}
                        onClick={() =>
                          patchForm({
                            actions: form.actions.filter((_, j) => j !== i),
                          })
                        }
                      >
                        ✕
                      </button>
                    </div>
                    <ActionTypeSelect
                      value={step.action_type}
                      onChange={(v) =>
                        patchForm({
                          actions: form.actions.map((s2, j) =>
                            j === i ? { ...s2, action_type: v } : s2,
                          ),
                        })
                      }
                      style={{ ...s.input, marginBottom: 6 }}
                    />
                    {!VOLUME_NO_VALUE.has(step.action_type) &&
                      step.action_type !== "audio_switch_device" && (
                        <input
                          style={{ ...s.input, marginBottom: 6 }}
                          value={step.action_value}
                          placeholder={actionPlaceholder(step.action_type)}
                          onChange={(e) =>
                            patchForm({
                              actions: form.actions.map((s2, j) =>
                                j === i
                                  ? { ...s2, action_value: e.target.value }
                                  : s2,
                              ),
                            })
                          }
                        />
                      )}
                    {step.action_type === "audio_switch_device" &&
                      (audioDevices.length > 0 ? (
                        <select
                          style={{ ...s.input, marginBottom: 6 }}
                          value={step.action_value}
                          onChange={(e) =>
                            patchForm({
                              actions: form.actions.map((s2, j) =>
                                j === i
                                  ? { ...s2, action_value: e.target.value }
                                  : s2,
                              ),
                            })
                          }
                        >
                          <option value="">— select device —</option>
                          {audioDevices.map((d) => (
                            <option key={d.id} value={d.name}>
                              {d.name}
                              {d.isDefault ? " ✓" : ""}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          style={{ ...s.input, marginBottom: 6 }}
                          value={step.action_value}
                          placeholder="Device name"
                          onChange={(e) =>
                            patchForm({
                              actions: form.actions.map((s2, j) =>
                                j === i
                                  ? { ...s2, action_value: e.target.value }
                                  : s2,
                              ),
                            })
                          }
                        />
                      ))}
                    <div
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <span
                        style={{ fontSize: 11, color: "#555", flexShrink: 0 }}
                      >
                        Delay before
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="50"
                        style={{ ...s.input, marginBottom: 0, width: 80 }}
                        value={step.delay_ms}
                        onChange={(e) =>
                          patchForm({
                            actions: form.actions.map((s2, j) =>
                              j === i
                                ? {
                                    ...s2,
                                    delay_ms: parseInt(e.target.value) || 0,
                                  }
                                : s2,
                            ),
                          })
                        }
                      />
                      <span style={{ fontSize: 11, color: "#555" }}>ms</span>
                    </div>
                  </div>
                ))}
                <div
                  style={{ fontSize: 11, color: "#444", textAlign: "center" }}
                >
                  Multi-action overrides the single action above.
                </div>
              </div>
            )}

            {/* FEATURE: Soundboard — sound upload + 3-way target selector */}
            <div
              style={{
                background: "#1a1200",
                border: "1px solid #3d2e00",
                borderRadius: 10,
                padding: 12,
                marginBottom: 16,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <label
                  style={{ ...s.label, color: "#f59e0b", marginBottom: 0 }}
                >
                  🔊 Button Sound
                </label>
                {form.sound_file && (
                  <button
                    style={{
                      background: "none",
                      border: "none",
                      color: "#ef4444",
                      cursor: "pointer",
                      fontSize: 11,
                    }}
                    onClick={async () => {
                      patchForm({ sound_file: null });
                      await fetch(`${API}/buttons/${editing}/sound`, {
                        method: "DELETE",
                      });
                      await loadPages();
                    }}
                  >
                    Remove ✕
                  </button>
                )}
              </div>

              {/* Sound upload */}
              {form.sound_file ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    marginBottom: 10,
                  }}
                >
                  <audio
                    controls
                    src={form.sound_file}
                    style={{ width: "100%", height: 32 }}
                  />
                  <label style={s.uploadLabel}>
                    🔄 Replace sound
                    <input
                      type="file"
                      accept="audio/*"
                      style={{ display: "none" }}
                      onChange={async (e) => {
                        const file = e.target.files[0];
                        if (!file || !editing) return;
                        const res = await fetch(
                          `${API}/buttons/${editing}/sound`,
                          {
                            method: "POST",
                            headers: { "Content-Type": file.type },
                            body: file,
                          },
                        );
                        patchForm({
                          sound_file: (await res.json()).sound_file,
                        });
                        await loadPages();
                      }}
                    />
                  </label>
                </div>
              ) : (
                <label
                  style={{
                    ...s.uploadLabel,
                    borderColor: "#3d2e00",
                    color: "#7a5a00",
                    marginBottom: 10,
                  }}
                >
                  🎵 Upload sound (mp3, wav, ogg…)
                  <input
                    type="file"
                    accept="audio/*"
                    style={{ display: "none" }}
                    onChange={async (e) => {
                      const file = e.target.files[0];
                      if (!file || !editing) return;
                      const res = await fetch(
                        `${API}/buttons/${editing}/sound`,
                        {
                          method: "POST",
                          headers: { "Content-Type": file.type },
                          body: file,
                        },
                      );
                      patchForm({ sound_file: (await res.json()).sound_file });
                      await loadPages();
                    }}
                  />
                </label>
              )}

              {/* FEATURE: Soundboard routing — 3-way target toggle */}
              {form.sound_file && (
                <>
                  <label
                    style={{ ...s.label, color: "#f59e0b", marginBottom: 6 }}
                  >
                    Play sound to
                  </label>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      gap: 6,
                      marginBottom: 6,
                    }}
                  >
                    {SOUND_TARGETS.map((t) => (
                      <div
                        key={t.value}
                        onClick={() => patchForm({ sound_target: t.value })}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 10,
                          padding: "8px 10px",
                          borderRadius: 8,
                          cursor: "pointer",
                          border: `1.5px solid ${form.sound_target === t.value ? "#f59e0b" : "#2a2000"}`,
                          background:
                            form.sound_target === t.value
                              ? "#2a1a00"
                              : "#1a1000",
                          transition: "all 0.12s",
                        }}
                      >
                        <div
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: "50%",
                            flexShrink: 0,
                            border: `2px solid ${form.sound_target === t.value ? "#f59e0b" : "#555"}`,
                            background:
                              form.sound_target === t.value
                                ? "#f59e0b"
                                : "transparent",
                          }}
                        />
                        <div>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              color:
                                form.sound_target === t.value
                                  ? "#f59e0b"
                                  : "#888",
                            }}
                          >
                            {t.label}
                          </div>
                          <div style={{ fontSize: 10, color: "#555" }}>
                            {t.desc}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  {(form.sound_target === "pc" ||
                    form.sound_target === "both") && (
                    <div
                      style={{
                        fontSize: 10,
                        color: "#7a5a00",
                        marginTop: 4,
                        lineHeight: 1.5,
                      }}
                    >
                      PC device set in{" "}
                      <strong style={{ color: "#f59e0b" }}>
                        ⚙ Audio settings
                      </strong>
                      . Make sure Voicemeeter is running.
                    </div>
                  )}
                </>
              )}

              <div style={{ fontSize: 10, color: "#4a3800", marginTop: 6 }}>
                Max 5 MB per clip.
              </div>
            </div>

            {/* Preview */}
            <label style={s.label}>Preview</label>
            <div style={{ ...s.preview, background: form.color }}>
              <div style={s.previewBar} />
              {form.icon_data ? (
                <img
                  src={form.icon_data}
                  style={{
                    width: 36,
                    height: 36,
                    borderRadius: 6,
                    objectFit: "cover",
                  }}
                />
              ) : (
                <span style={{ fontSize: 28 }}>{form.icon}</span>
              )}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  color: "#fff",
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  textAlign: "center",
                  maxWidth: "90%",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {form.label}
              </span>
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button style={s.saveBtn} onClick={saveButton} disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </button>
              <button style={s.cancelBtn} onClick={() => setEditing(null)}>
                Cancel
              </button>
              <button style={s.deleteBtn} onClick={() => deleteButton(editing)}>
                Delete
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ActionTypeSelect({ value, onChange, style }) {
  return (
    <select
      style={style}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {ACTION_GROUPS.map((group) => (
        <optgroup key={group.label} label={group.label}>
          {group.types.map((t) => (
            <option key={t} value={t}>
              {actionTypeLabel(t)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

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
  const patchCondition = (index, patch) => {
    patchRule({
      conditions: conditions.map((condition, i) =>
        i === index ? { ...condition, ...patch } : condition,
      ),
    });
  };

  return (
    <div style={styles.rulePanel}>
      <div style={styles.ruleHeader}>
        <div>
          <div style={styles.ruleTitle}>Auto profile switching</div>
          <div style={styles.ruleMeta}>
            {activeWindow?.process
              ? `${activeWindow.process} · ${activeWindow.windowTitle || "Untitled"}`
              : "No active app captured yet"}
          </div>
        </div>
        <label style={styles.switchRow}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => onToggleGlobal(e.target.checked)}
          />
          Enabled
        </label>
      </div>

      <div style={styles.ruleActions}>
        <button style={styles.smallBtn} onClick={onSelectRunningApp}>
          Select running app
        </button>
        <button
          style={styles.smallBtn}
          onClick={onCaptureDelayed}
          disabled={captureCountdown > 0}
        >
          {captureCountdown > 0 ? `Capturing in ${captureCountdown}` : "Capture in 3s"}
        </button>
        <button style={styles.smallBtn} onClick={onRefreshCurrentApp}>
          Refresh
        </button>
        {rule && (
          <button style={styles.smallDangerBtn} onClick={onDelete}>
            Remove rule
          </button>
        )}
      </div>

      <div style={styles.ruleGrid}>
        <label style={styles.miniLabel}>Rule enabled</label>
        <input
          type="checkbox"
          checked={!!draft.enabled}
          onChange={(e) => patchRule({ enabled: e.target.checked })}
        />

        <label style={styles.miniLabel}>Logic</label>
        <select
          style={styles.compactInput}
          value={draft.logic || "AND"}
          onChange={(e) => patchRule({ logic: e.target.value })}
        >
          <option value="AND">AND</option>
          <option value="OR">OR</option>
        </select>

        <label style={styles.miniLabel}>Priority</label>
        <input
          type="number"
          min="0"
          max="1000"
          style={styles.compactInput}
          value={draft.priority ?? 100}
          onChange={(e) => patchRule({ priority: Number(e.target.value) || 0 })}
        />
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {conditions.map((condition, index) => (
          <div key={index} style={styles.conditionRow}>
            <select
              style={styles.compactInput}
              value={condition.type}
              onChange={(e) => patchCondition(index, { type: e.target.value })}
            >
              {CONDITION_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </select>
            <select
              style={styles.compactInput}
              value={condition.operator}
              onChange={(e) =>
                patchCondition(index, { operator: e.target.value })
              }
            >
              {CONDITION_OPERATORS.map((operator) => (
                <option key={operator.value} value={operator.value}>
                  {operator.label}
                </option>
              ))}
            </select>
            <input
              style={{ ...styles.compactInput, flex: 1 }}
              value={condition.value || ""}
              disabled={condition.operator === "exists"}
              placeholder={
                condition.type === "process"
                  ? "Code.exe"
                  : condition.type === "window_title"
                    ? "workspace"
                    : "C:\\Path\\App.exe"
              }
              onChange={(e) => patchCondition(index, { value: e.target.value })}
            />
            <button
              style={styles.iconBtn}
              onClick={() =>
                patchRule({
                  conditions: conditions.filter((_, i) => i !== index),
                })
              }
              disabled={conditions.length === 1}
            >
              x
            </button>
          </div>
        ))}
      </div>

      <button
        style={styles.addConditionBtn}
        onClick={() =>
          patchRule({ conditions: [...conditions, emptyCondition()] })
        }
      >
        + Add condition
      </button>

      {showAppPicker && (
        <div style={styles.appPicker}>
          <div style={styles.appPickerHeader}>
            <span>Select running app</span>
            <button style={styles.iconBtn} onClick={onClosePicker}>
              x
            </button>
          </div>
          <div style={styles.appPickerList}>
            {openWindows.length === 0 && (
              <div style={styles.emptyPicker}>No visible app windows found.</div>
            )}
            {openWindows.map((app, index) => (
              <button
                key={`${app.pid}-${app.windowTitle}-${index}`}
                style={styles.appPickerItem}
                onClick={() => onPickApp(app)}
              >
                <span style={styles.appProcess}>{app.process}</span>
                <span style={styles.appTitle}>{app.windowTitle}</span>
                <span style={styles.appPath}>{app.executablePath || "Path unavailable"}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Badge({ color, bg, children }) {
  return (
    <span
      style={{
        marginLeft: 5,
        fontSize: 10,
        color,
        background: bg,
        borderRadius: 4,
        padding: "1px 5px",
      }}
    >
      {children}
    </span>
  );
}

function actionTypeLabel(type) {
  return (
    {
      keystroke: "Keystroke",
      type: "Type Text",
      shell: "Shell Command",
      url: "Open URL",
      launch: "Launch App",
      volume_up: "Volume Up",
      volume_down: "Volume Down",
      volume_set: "Set Volume",
      volume_mute: "Mute Toggle",
      audio_switch_device: "Switch Audio Output",
    }[type] ?? type
  );
}

function actionLabel(type) {
  return (
    {
      keystroke: "Key combo (e.g. ctrl+s)",
      type: "Text to type",
      shell: "Shell command",
      url: "URL to open",
      launch: "Application path",
      audio_switch_device: "Device name",
    }[type] ?? "Value"
  );
}

function actionPlaceholder(type) {
  return (
    {
      keystroke: "ctrl+s",
      type: "Hello world",
      shell: "cmd.exe",
      url: "https://example.com",
      launch: "C:\\Path\\To\\App.exe",
      volume_up: "5",
      volume_down: "5",
      volume_set: "50",
      audio_switch_device: "Voicemeeter Input (VB-Audio Voicemeeter VAIO)",
    }[type] ?? ""
  );
}

const styles = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100dvh",
    background: "#0f0f13",
    color: "#fff",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    background: "#1a1a22",
    borderBottom: "1px solid #2a2a35",
    flexShrink: 0,
  },
  backBtn: {
    background: "none",
    border: "1px solid #333",
    borderRadius: 6,
    color: "#aaa",
    cursor: "pointer",
    padding: "4px 10px",
    fontSize: 12,
  },
  body: { display: "flex", flex: 1, overflow: "hidden" },
  sidebar: {
    width: 140,
    background: "#13131a",
    borderRight: "1px solid #2a2a35",
    display: "flex",
    flexDirection: "column",
    padding: 8,
    gap: 2,
    overflowY: "auto",
    flexShrink: 0,
  },
  sidebarLabel: {
    fontSize: 10,
    color: "#444",
    fontWeight: 700,
    padding: "4px 6px",
    letterSpacing: 1,
  },
  pageItem: {
    padding: "8px 10px",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: 13,
    display: "flex",
    alignItems: "center",
    gap: 4,
    color: "#888",
  },
  pageItemActive: { background: "#1e1e2e", color: "#fff" },
  iconBtn: {
    background: "none",
    border: "none",
    color: "#444",
    cursor: "pointer",
    fontSize: 11,
    padding: "0 2px",
  },
  addPageBtn: {
    marginTop: 4,
    background: "none",
    border: "1px dashed #333",
    borderRadius: 8,
    color: "#555",
    cursor: "pointer",
    padding: "6px 8px",
    fontSize: 12,
  },
  buttonList: {
    flex: 1,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  listHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "12px 16px",
    borderBottom: "1px solid #1e1e2e",
  },
  rulePanel: {
    margin: "12px 16px",
    padding: 12,
    borderRadius: 8,
    background: "#141820",
    border: "1px solid #263040",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  ruleHeader: {
    display: "flex",
    alignItems: "flex-start",
    justifyContent: "space-between",
    gap: 12,
  },
  ruleTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: "#93c5fd",
    marginBottom: 3,
  },
  ruleMeta: {
    fontSize: 11,
    color: "#64748b",
    maxWidth: 420,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  switchRow: {
    display: "flex",
    alignItems: "center",
    gap: 6,
    color: "#94a3b8",
    fontSize: 12,
    flexShrink: 0,
  },
  ruleActions: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  smallBtn: {
    background: "#1e293b",
    border: "1px solid #334155",
    borderRadius: 7,
    color: "#cbd5e1",
    cursor: "pointer",
    padding: "6px 9px",
    fontSize: 11,
  },
  smallDangerBtn: {
    background: "#2a1518",
    border: "1px solid #4a2028",
    borderRadius: 7,
    color: "#f87171",
    cursor: "pointer",
    padding: "6px 9px",
    fontSize: 11,
  },
  ruleGrid: {
    display: "grid",
    gridTemplateColumns: "auto 90px auto 90px auto 80px",
    gap: 8,
    alignItems: "center",
  },
  miniLabel: {
    fontSize: 11,
    color: "#64748b",
    fontWeight: 600,
  },
  compactInput: {
    background: "#0f172a",
    border: "1px solid #263040",
    borderRadius: 7,
    color: "#e2e8f0",
    padding: "6px 8px",
    fontSize: 12,
    outline: "none",
    boxSizing: "border-box",
    minWidth: 0,
  },
  conditionRow: {
    display: "grid",
    gridTemplateColumns: "130px 120px minmax(120px, 1fr) 28px",
    gap: 6,
    alignItems: "center",
  },
  addConditionBtn: {
    alignSelf: "flex-start",
    background: "none",
    border: "1px dashed #334155",
    borderRadius: 7,
    color: "#64748b",
    cursor: "pointer",
    padding: "6px 9px",
    fontSize: 11,
  },
  appPicker: {
    borderRadius: 8,
    border: "1px solid #334155",
    background: "#0f172a",
    overflow: "hidden",
  },
  appPickerHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "8px 10px",
    borderBottom: "1px solid #263040",
    color: "#cbd5e1",
    fontSize: 12,
    fontWeight: 700,
  },
  appPickerList: {
    maxHeight: 240,
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
  },
  appPickerItem: {
    display: "grid",
    gridTemplateColumns: "140px minmax(160px, 1fr)",
    gap: "2px 10px",
    textAlign: "left",
    background: "none",
    border: "none",
    borderBottom: "1px solid #1e293b",
    color: "#e2e8f0",
    cursor: "pointer",
    padding: "8px 10px",
  },
  appProcess: {
    fontSize: 12,
    fontWeight: 700,
    color: "#93c5fd",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  appTitle: {
    fontSize: 12,
    color: "#cbd5e1",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  appPath: {
    gridColumn: "1 / -1",
    fontSize: 10,
    color: "#64748b",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  emptyPicker: {
    padding: 12,
    fontSize: 12,
    color: "#64748b",
  },
  addBtn: {
    background: "#5B4FCF",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    cursor: "pointer",
    padding: "6px 12px",
    fontSize: 12,
    fontWeight: 600,
  },
  btnRow: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 16px",
    borderBottom: "1px solid #1a1a22",
    cursor: "pointer",
    transition: "background 0.1s",
  },
  btnRowActive: { background: "#1e1e2e" },
  colorDot: {
    width: 36,
    height: 36,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 18,
    flexShrink: 0,
  },
  editPanel: {
    width: 270,
    background: "#13131a",
    borderLeft: "1px solid #2a2a35",
    padding: 16,
    overflowY: "auto",
    flexShrink: 0,
  },
  editHeader: { fontWeight: 700, fontSize: 14, marginBottom: 16 },
  label: {
    display: "block",
    fontSize: 11,
    color: "#666",
    fontWeight: 600,
    marginBottom: 4,
    letterSpacing: 0.5,
  },
  input: {
    width: "100%",
    background: "#1e1e2e",
    border: "1px solid #2a2a35",
    borderRadius: 8,
    color: "#fff",
    padding: "8px 10px",
    fontSize: 13,
    marginBottom: 16,
    outline: "none",
    boxSizing: "border-box",
  },
  uploadLabel: {
    flex: 1,
    background: "#1e1e2e",
    border: "1px dashed #333",
    borderRadius: 8,
    padding: "7px 8px",
    cursor: "pointer",
    fontSize: 11,
    color: "#666",
    textAlign: "center",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  browseBtn: {
    background: "#1e1e2e",
    border: "1px solid #2a2a35",
    borderRadius: 8,
    color: "#aaa",
    cursor: "pointer",
    padding: "0 10px",
    fontSize: 13,
    flexShrink: 0,
  },
  preview: {
    borderRadius: 12,
    padding: "14px 10px",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 6,
    width: 90,
    marginBottom: 16,
    position: "relative",
    overflow: "hidden",
  },
  previewBar: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    background: "rgba(255,255,255,0.4)",
  },
  saveBtn: {
    flex: 1,
    background: "#5B4FCF",
    border: "none",
    borderRadius: 8,
    color: "#fff",
    cursor: "pointer",
    padding: "8px 0",
    fontSize: 13,
    fontWeight: 600,
  },
  cancelBtn: {
    background: "#1e1e2e",
    border: "none",
    borderRadius: 8,
    color: "#aaa",
    cursor: "pointer",
    padding: "8px 12px",
    fontSize: 13,
  },
  deleteBtn: {
    background: "#3d1a1a",
    border: "none",
    borderRadius: 8,
    color: "#ef4444",
    cursor: "pointer",
    padding: "8px 12px",
    fontSize: 13,
  },
  infoBox: {
    background: "#0a1a2e",
    border: "1px solid #1a3a5c",
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
    fontSize: 12,
    color: "#60a5fa",
  },
  sliderBox: {
    background: "#0a1a2e",
    border: "1px solid #1a3a5c",
    borderRadius: 10,
    padding: 12,
    marginBottom: 16,
  },
  sliderVal: {
    color: "#60a5fa",
    fontWeight: 700,
    fontSize: 13,
    width: 32,
    textAlign: "right",
  },
};

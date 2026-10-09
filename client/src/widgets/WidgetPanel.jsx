/**
 * WidgetPanel.jsx  —  client/src/widgets/WidgetPanel.jsx
 *
 * The drawer that configures a live widget: type, data source, which host,
 * refresh interval, which metrics, size, label, icon and colour.
 *
 * It mirrors PropertyPanel's shape on purpose — same Field/Toggle/segmented
 * primitives, same save/revert/delete header, same dirty pip — so editing a
 * tile feels exactly like editing a key.
 *
 * The remote section is deliberately created inline rather than in a
 * full-screen modal: a host is configured once and then forgotten, and forcing
 * the editor closed to reach it would be friction for no gain.
 */
import { ActionIcon, Icon } from "../icons.jsx";
import { WIDGET_SIZES, METRIC_REGISTRY, widgetTypeById } from "./registry.js";
import { getApiUrl } from "../constants.js";
import { Field, Toggle } from "./panelParts.jsx";
import { COLORS } from "./panelHelpers.js";

/** The dropdown value that opens the create-host form. */
const ADD_SOURCE_VALUE = "__add_source__";

const REFRESH_OPTIONS = [
  { value: 2000, label: "2s" },
  { value: 5000, label: "5s" },
  { value: 10000, label: "10s" },
  { value: 30000, label: "30s" },
  { value: 60000, label: "1m" },
];

export default function WidgetPanel({
  widget,
  form,
  dirty,
  sources,
  agentInfo,
  testing,
  testResult,
  onPatch,
  onSetSources,
  onTest,
  onSave,
  onRevert,
  onDelete,
  onDeleteSource,
  // --- adding a remote host ---
  addingSource,
  draft,
  onStartAddSource,
  onDraft,
  onCancelAddSource,
  onSaveSource,
}) {
  const type = widgetTypeById(widget.type);
  const isRemote = form.source_id !== null && form.source_id !== undefined;
  const source = sources.find((s) => s.id === form.source_id);

  return (
    <div style={styles.panel}>
      {/* Header: the same dirty pip / Save / Revert / Delete row the key editor
          uses, so saving a tile is muscle memory rather than a new convention. */}
      <div style={styles.panelHead}>
        <div style={styles.panelTitle}>
          <span style={styles.titleText}>Widget</span>
          <span style={styles.subText}>{type.name}</span>
        </div>
        <div style={styles.headerActions}>
          {dirty ? (
            <button style={styles.revertBtn} onClick={onRevert} title="Discard changes">
              <Icon name="close" size={13} />
            </button>
          ) : null}
          <button
            style={{
              ...styles.saveBtn,
              ...(dirty ? {} : styles.saveBtnClean),
            }}
            onClick={onSave}
            disabled={!dirty}
          >
            {dirty ? "Save" : "Saved"}
          </button>
          <button style={styles.revertBtn} onClick={onDelete} title="Delete widget">
            <Icon name="delete" size={13} />
          </button>
        </div>
      </div>
      <div style={styles.panelInner}>
        <Field label="Widget">
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "7px 10px",
              background: "#222222",
              border: "1px solid #333333",
              borderRadius: 7,
            }}
          >
            <span style={{ color: "#3d8fd6", display: "flex" }}>
              <ActionIcon name={form.icon || type.icon} size={16} />
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#d4d4d4" }}>
              {type.name}
            </span>
          </div>
        </Field>

        {/* --- Data source ---------------------------------------------- */}
        <div style={styles.sectionHead}>
          <span style={styles.sectionLabel}>Data source</span>
        </div>

        <Field label="Source">
          <select
            value={addingSource ? ADD_SOURCE_VALUE : form.source_id ?? ""}
            onChange={(e) => {
              const next = e.target.value;
              if (next === ADD_SOURCE_VALUE) onStartAddSource();
              else onPatch({ source_id: next === "" ? null : next });
            }}
          >
            <option value="">This PC (local)</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.host}
              </option>
            ))}
            {/* Without this the list can only ever hold the local machine: a
                remote host has no other way in, because the host fields below
                are for editing a source that already exists. */}
            <option value={ADD_SOURCE_VALUE}>＋ Add Remote Host…</option>
          </select>
        </Field>

        {addingSource ? (
          <HostFields
            // A draft, not a row: nothing is written until Save host, so a
            // half-typed hostname can never end up in the database.
            draft={draft}
            agentInfo={agentInfo}
            testing={testing}
            testResult={testResult}
            onDraft={onDraft}
            onTest={onTest}
            onSave={onSaveSource}
            onCancel={onCancelAddSource}
          />
        ) : isRemote && source ? (
          <>
            {/* Host connection, editable in place. A host is configured here
                rather than in a modal so the tile you are editing and the
                settings it depends on are on screen at the same time. */}
            <div style={styles.group}>
              <div style={styles.groupRow}>
                <input
                  placeholder="Host or IP"
                  value={source.host || ""}
                  onChange={(e) => onPatchSource(source.id, { host: e.target.value }, onSetSources)}
                />
                <input
                  style={{ width: 68 }}
                  placeholder="Port"
                  value={source.port ?? 22}
                  onChange={(e) =>
                    onPatchSource(source.id, { port: e.target.value }, onSetSources)
                  }
                />
              </div>
              <input
                placeholder="Username"
                value={source.username || ""}
                onChange={(e) =>
                  onPatchSource(source.id, { username: e.target.value }, onSetSources)
                }
              />
              <input
                placeholder="Private key path (e.g. C:\Users\you\.ssh\id_ed25519)"
                value={source.key_path || ""}
                onChange={(e) =>
                  onPatchSource(source.id, { key_path: e.target.value }, onSetSources)
                }
              />
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginTop: 2,
                }}
              >
                <Toggle
                  value={!!source.use_agent}
                  onChange={(v) =>
                    onPatchSource(source.id, { use_agent: v }, onSetSources)
                  }
                  // Only offered when the OpenSSH agent is actually running: a
                  // pipe that is not there produces a confusing connect error
                  // instead of a reason.
                  disabled={agentInfo ? !agentInfo.reachable : true}
                />
                <span style={styles.hint}>{agentHint(agentInfo)}</span>
              </div>
              <div style={styles.groupRow}>
                <button style={styles.testBtn} onClick={onTest} disabled={testing}>
                  {testing ? "Testing…" : "Test connection"}
                </button>
                <button
                  style={styles.deleteSourceBtn}
                  onClick={() => onDeleteSource(source.id)}
                >
                  Delete source
                </button>
              </div>
              {testResult ? (
                <div
                  style={{
                    ...styles.testResult,
                    color: testResult.ok ? "#4ade80" : "#f87171",
                  }}
                >
                  {testResultLabel(testResult)}
                </div>
              ) : null}
              <p style={styles.note}>
                Passwords are never stored. If the key file is encrypted, save it
                once on the desktop app and the passphrase is kept by the OS
                credential store.
              </p>
            </div>
          </>
        ) : isRemote ? (
          <p style={styles.note}>This host no longer exists — pick another, or local.</p>
        ) : null}

        {isRemote && !addingSource && (
          <Field label="Refresh">
            <div style={{ display: "flex", gap: 6 }}>
              {REFRESH_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  style={{
                    ...styles.segBtn,
                    ...(Number(source?.refresh_ms) === opt.value ? styles.segBtnActive : {}),
                  }}
                  onClick={() =>
                    onPatchSource(source?.id, { refresh_ms: opt.value }, onSetSources)
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </Field>
        )}

        {/* --- Appearance ---------------------------------------------- */}
        <div style={styles.sectionHead}>
          <span style={styles.sectionLabel}>Display</span>
        </div>

        <Field label="Size">
          <div style={{ display: "flex", gap: 6 }}>
            {WIDGET_SIZES.map((size) => (
              <button
                key={size.value}
                style={{
                  ...styles.segBtn,
                  ...(form.size === size.value ? styles.segBtnActive : {}),
                }}
                onClick={() => onPatch({ size: size.value })}
              >
                {size.label}
              </button>
            ))}
          </div>
        </Field>

        <Field label="Label">
          <input
            value={form.label || ""}
            onChange={(e) => onPatch({ label: e.target.value })}
            placeholder="Tile label"
          />
        </Field>

        <Field label="Metrics">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {METRIC_REGISTRY.map((metric) => {
              const on = (form.config?.metrics || []).includes(metric.id);
              return (
                <button
                  key={metric.id}
                  style={{
                    ...styles.chipBtn,
                    ...(on ? styles.chipBtnOn : {}),
                  }}
                  onClick={() => onPatch({ config: { metrics: toggleMetric(form.config, metric.id) } })}
                >
                  <ActionIcon name={metric.icon} size={12} />
                  {metric.label}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Color">
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", alignItems: "center" }}>
            {COLORS.map((c) => (
              <div
                key={c}
                onClick={() => onPatch({ color: c })}
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: c,
                  cursor: "pointer",
                  border: form.color === c ? "2px solid #fff" : "1px solid #333",
                }}
              />
            ))}
          </div>
        </Field>

        <div style={styles.spacer} />
      </div>
    </div>
  );
}

/** The agent toggle's caption, for each state the probe can report. */
function agentHint(agentInfo) {
  if (!agentInfo) return "Checking the SSH agent...";
  if (!agentInfo.supported) return "SSH agent is only available on Windows";
  if (!agentInfo.reachable) return `SSH agent unavailable - ${agentInfo.reason || "not running"}`;
  return "Use the Windows OpenSSH agent";
}

/**
 * The host form, shared by "add a host" and "edit this host" so the two can
 * never drift — only the heading and the buttons differ.
 */
function HostFields({
  draft,
  agentInfo,
  testing,
  testResult,
  onDraft,
  onTest,
  onSave,
  onCancel,
  heading,
}) {
  const set = (key, value) => onDraft({ ...draft, [key]: value });

  return (
    <div style={styles.group}>
      <div style={styles.groupHeading}>{heading}</div>
      <div style={styles.groupRow}>
        <input
          placeholder="Display name"
          value={draft.name || ""}
          onChange={(e) => set("name", e.target.value)}
        />
        <input
          style={{ width: 68 }}
          placeholder="Port"
          value={draft.port ?? 22}
          onChange={(e) => set("port", e.target.value)}
        />
      </div>
      <input
        placeholder="Host or IP (e.g. 192.168.100.36)"
        value={draft.host || ""}
        onChange={(e) => set("host", e.target.value)}
      />
      <input
        placeholder="Username"
        value={draft.username || ""}
        onChange={(e) => set("username", e.target.value)}
      />
      <input
        placeholder="Private key path"
        value={draft.key_path || ""}
        onChange={(e) => set("key_path", e.target.value)}
      />
      <div style={styles.groupRow}>
        <button style={styles.testBtn} onClick={onTest} disabled={testing || !draft.host}>
          {testing ? "Testing…" : "Test connection"}
        </button>
        <button
          style={styles.primaryBtn}
          onClick={onSave}
          disabled={testing || !draft.name?.trim() || !draft.host?.trim()}
        >
          Save host
        </button>
        {onCancel ? (
          <button style={styles.deleteSourceBtn} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
      </div>
      {testResult ? (
        <div
          style={{
            ...styles.testResult,
            color: testResult.ok ? "#4ade80" : "#f87171",
          }}
        >
          {testResultLabel(testResult)}
        </div>
      ) : null}
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Toggle
          value={!!draft.use_agent}
          onChange={(v) => set("use_agent", v)}
          disabled={agentInfo ? !agentInfo.reachable : true}
        />
        <span style={styles.hint}>{agentHint(agentInfo)}</span>
      </div>
      <Field label="Refresh">
        <div style={{ display: "flex", gap: 6 }}>
          {REFRESH_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              style={{
                ...styles.segBtn,
                ...(Number(draft.refresh_ms) === opt.value ? styles.segBtnActive : {}),
              }}
              onClick={() => set("refresh_ms", opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </Field>
      <p style={styles.note}>
        Passwords are never stored, and the key file's contents are never read
        into the app — only the path is kept, and the SSH client opens it
        directly.
      </p>
    </div>
  );
}

/** Result of the Test connection button, as one readable line. */
function testResultLabel(result) {
  if (result.ok) return `Connected - ${result.detail || "ok"}`;
  return `Failed - ${result.reason || "unknown error"}`;
}

/** Writes straight through to the source endpoint, then refreshes the list. */
function onPatchSource(id, fields, setSources) {
  fetch(`${getApiUrl()}/widget-sources/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  })
    .then((r) => r.json())
    .then((updated) => {
      setSources((prev) => prev.map((s) => (s.id === id ? updated : s)));
    })
    .catch(() => {});
}

function toggleMetric(config, id) {
  const current = config?.metrics || [];
  return current.includes(id) ? current.filter((m) => m !== id) : [...current, id];
}

const styles = {
  panelHead: {
    height: 40,
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "0 12px 0 16px",
    borderBottom: "1px solid #2a2a2e",
    background: "linear-gradient(180deg, #1c1c1f 0%, #161618 100%)",
  },
  panelTitle: { display: "flex", flexDirection: "column", gap: 1, minWidth: 0 },
  titleText: { fontSize: 13, fontWeight: 700, color: "#e8e8ec" },
  subText: {
    fontSize: 10,
    fontWeight: 500,
    color: "#5a5a5a",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  headerActions: { marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 },
  revertBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 28,
    height: 24,
    borderRadius: 7,
    background: "rgba(255,255,255,0.06)",
    border: "1px solid rgba(255,255,255,0.10)",
    color: "#888",
    cursor: "pointer",
  },
  saveBtn: {
    padding: "0 14px",
    height: 24,
    borderRadius: 7,
    background: "rgba(79,128,255,0.20)",
    border: "1px solid rgba(79,128,255,0.45)",
    color: "#3d8fd6",
    fontSize: 12,
    fontWeight: 700,
    cursor: "pointer",
  },
  saveBtnClean: {
    background: "transparent",
    border: "1px solid #2a2a2a",
    color: "#4a4a4a",
    cursor: "default",
  },
  panel: {
    height: 264,
    flexShrink: 0,
    borderTop: "1px solid #2a2a2e",
    background: "#1e1e1e",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  panelInner: {
    flex: 1,
    minHeight: 0,
    overflowY: "auto",
    padding: "12px 16px 16px",
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
    gap: "6px 14px",
    alignContent: "start",
  },
  sectionHead: {
    gridColumn: "1 / -1",
    display: "flex",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
  },
  sectionLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "#5a5a5a",
  },
  group: {
    gridColumn: "1 / -1",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    padding: "8px 10px",
    background: "rgba(255,255,255,0.02)",
    border: "1px solid rgba(255,255,255,0.05)",
    borderRadius: 8,
  },
  groupRow: { display: "flex", gap: 6 },
  groupHeading: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.5,
    textTransform: "uppercase",
    color: "#6a6a6a",
  },
  primaryBtn: {
    padding: "5px 12px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 700,
    background: "rgba(79,128,255,0.20)",
    border: "1px solid rgba(79,128,255,0.45)",
    color: "#3d8fd6",
    cursor: "pointer",
  },
  hint: { fontSize: 10.5, color: "#666", lineHeight: 1.4 },
  note: {
    fontSize: 10,
    color: "#555",
    margin: "2px 0 0",
    lineHeight: 1.5,
  },
  testBtn: {
    padding: "5px 11px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 600,
    background: "#1e1e1e",
    border: "1px solid #333333",
    color: "#d4d4d4",
    cursor: "pointer",
  },
  deleteSourceBtn: {
    padding: "5px 11px",
    borderRadius: 7,
    fontSize: 11,
    fontWeight: 600,
    background: "transparent",
    border: "1px solid #4a2626",
    color: "#c66",
    cursor: "pointer",
  },
  testResult: { fontSize: 10.5, fontWeight: 600, lineHeight: 1.4 },
  segBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
    padding: "5px 10px",
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
  chipBtn: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    padding: "4px 9px",
    borderRadius: 999,
    fontSize: 10.5,
    fontWeight: 600,
    background: "#1e1e1e",
    border: "1px solid #333333",
    color: "#606060",
    cursor: "pointer",
  },
  chipBtnOn: {
    background: "rgba(79,128,255,0.15)",
    border: "1px solid rgba(79,128,255,0.4)",
    color: "#3d8fd6",
  },
  spacer: { gridColumn: "1 / -1", height: 4 },
};

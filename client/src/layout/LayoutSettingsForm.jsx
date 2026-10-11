// Phase 6, Task 6.1 — the layout settings form. Desktop-only since the final
// polish: it renders inside DesktopApp.jsx's Layout Settings modal. It is a PURE
// CONTROLLED component: no fetch, no toast, no routing — the container owns
// the HTTP call and its feedback. It renders a full merged engine settings
// object (mergeLayout's output) and calls onSave(partial, scope) where
// `partial` contains ONLY the keys the user actively touched (explicit nulls
// clear a key at the target scope) and scope is "global", or "page" only
// while "Apply to this page" is on with a real page behind it. All the diff
// rules live in the pure layoutForm.js module beside it, unit-tested without
// a DOM.
//
// Phase 6, Task 6.2 adds the Presets section: Save-as-preset (a name + the
// buildPresetSnapshot scope diff), an Apply picker, and a two-tap non-modal
// Delete. It stays fetch-free: the snapshot is computed here from the form's
// own pending diff, and every wire action is delegated to the container
// callbacks (onSavePreset / onApplyPreset / onDeletePreset). The section
// renders only when the preset props are provided, so tests (and any future
// surface) can still mount the bare 6.1 form.
import { useEffect, useRef, useState } from "react";
import {
  COLS_MAX,
  COLS_MIN,
  GAP_MAX,
  GAP_MIN,
  MAX_CELL_MAX,
  MAX_CELL_MIN,
  MIN_CELL_MAX,
  MIN_CELL_MIN,
  PRESET_CHOICES,
  PRESET_NAME_MAX,
  buildPartial,
  buildPresetSnapshot,
  computeSaveEnabled,
  initialValues,
  pickPreset,
  sanitizePresetName,
  setValue,
} from "./layoutForm.js";

// Palette reuses the app's dark surface tokens (#1a1a22 fills, #2a2a35
// hairlines, #3b82f6 accent) so the form reads as part of the desktop UI.
const styles = {
  form: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    padding: "10px 0 4px",
    fontSize: 11,
    color: "#c0c0cc",
    textAlign: "left",
  },
  caption: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: "#55556a",
  },
  label: { fontWeight: 700, color: "#8888a0", fontSize: 10 },
  hint: { color: "#666678", fontSize: 10, lineHeight: 1.5 },
  segRow: { display: "flex", gap: 4, flexWrap: "wrap" },
  sliderRow: { display: "flex", flexDirection: "column", gap: 2 },
  sliderHead: { display: "flex", justifyContent: "space-between", gap: 8 },
  slider: { width: "100%", accentColor: "#3b82f6", height: 24 },
  save: {
    padding: "7px 16px",
    borderRadius: 10,
    border: "none",
    background: "linear-gradient(135deg,#3d8fd6,#9333ea)",
    color: "#fff",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    alignSelf: "flex-start",
  },
  toggleTrack: (on) => ({
    width: 34,
    height: 19,
    boxSizing: "border-box",
    borderRadius: 10,
    background: on ? "#3b82f6" : "#2a2a35",
    border: `1px solid ${on ? "#3b82f6" : "#3a3a45"}`,
    position: "relative",
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
    transition: "background 0.15s ease",
  }),
  toggleThumb: (on) => ({
    position: "absolute",
    top: 2,
    left: on ? 16 : 2,
    width: 13,
    height: 13,
    borderRadius: "50%",
    background: "#fff",
    transition: "left 0.15s ease",
  }),
  // Task 6.2 preset controls — same dark tokens (#1a1a22 fills, #2a2a35
  // hairlines), keeping the form's compact sizing the modal inherits.
  presetRow: { display: "flex", gap: 4, alignItems: "center" },
  presetInput: {
    flex: 1,
    minWidth: 0,
    padding: "6px 10px",
    borderRadius: 10,
    border: "1px solid #2a2a35",
    background: "#1a1a22",
    color: "#e0e0ec",
    fontSize: 11,
  },
  presetSelect: {
    width: "100%",
    padding: "6px 8px",
    borderRadius: 10,
    border: "1px solid #2a2a35",
    background: "#1a1a22",
    color: "#e0e0ec",
    fontSize: 11,
  },
  presetButton: (danger) => ({
    padding: "6px 10px",
    borderRadius: 10,
    border: `1px solid ${danger ? "#5c1a1a" : "#2a2a35"}`,
    background: danger ? "#2e0d0d" : "#2a2a35",
    color: danger ? "#f87171" : "#c0c0cc",
    fontSize: 11,
    fontWeight: 700,
    cursor: "pointer",
    flexShrink: 0,
  }),
};

function segButton(active) {
  return {
    display: "flex",
    alignItems: "center",
    gap: 4,
    height: 26,
    padding: "0 10px",
    background: active ? "#2a2a35" : "#1a1a22",
    border: `1px solid ${active ? "#3b82f6" : "#2a2a35"}`,
    borderRadius: 12,
    color: active ? "#e0e0ec" : "#8888a0",
    fontSize: 11,
    fontWeight: 600,
    cursor: "pointer",
  };
}

// One segmented picker, spoken as a radio group: the options are mutually
// exclusive and one is always lit, which is exactly radio semantics.
function Segmented({ label, options, value, onPick }) {
  return (
    <div role="radiogroup" aria-label={label}>
      <div style={styles.label}>{label}</div>
      <div style={styles.segRow}>
        {options.map(([key, text]) => (
          <button
            key={key}
            type="button"
            role="radio"
            aria-checked={value === key}
            style={segButton(value === key)}
            onClick={() => onPick(key)}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function SliderRow({ label, min, max, unit, value, onChange, hint }) {
  return (
    <label style={styles.sliderRow}>
      <span style={styles.sliderHead}>
        <span style={styles.label}>{label}</span>
        <span style={{ color: "#8888a0", fontVariantNumeric: "tabular-nums" }}>
          {value}
          {unit}
        </span>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-label={`${label}, ${min} to ${max} ${unit}`}
        onChange={(e) => onChange(Number(e.target.value))}
        style={styles.slider}
      />
      {hint ? <span style={styles.hint}>{hint}</span> : null}
    </label>
  );
}

export default function LayoutSettingsForm({
  initialConfig,
  pageName,
  onSave,
  // Task 6.2 preset contract (all optional — the section renders only when
  // they are provided): the container's fetched preset rows, and its three
  // wire callbacks. pageId / pageStoredConfig locate the page scope for the
  // snapshot; without them a preset can still save/apply the global scope.
  presets,
  onSavePreset,
  onApplyPreset,
  onDeletePreset,
  pageId,
  pageStoredConfig,
}) {
  // The diff itself: key -> pending value, present only when touched. The
  // display layerings (`changes.x ?? base.x`) never write back into it, so a
  // Save after an untouched form is provably `{}` (see layoutForm.test.js).
  const [changes, setChanges] = useState({});
  const [applyToPage, setApplyToPage] = useState(false);
  const [busy, setBusy] = useState(false);
  // Re-derived every render (not frozen at mount): a `state` broadcast while
  // the form is open updates the merged config underneath, and untouched
  // knobs should follow it. Touched keys keep the user's pending values.
  const base = initialValues(initialConfig);
  const view = {
    mode: changes.mode ?? base.mode,
    preset: changes.preset ?? base.preset,
    cols: changes.cols ?? base.cols,
    minCell: changes.minCell ?? base.minCell,
    maxCell: changes.maxCell ?? base.maxCell,
    gap: changes.gap ?? base.gap,
  };

  // Save gate (see layoutForm.computeSaveEnabled): disabled while the diff is
  // empty (a no-op Save would flash false success) or while the cell bounds are
  // inverted (minCell > maxCell resolves a sub-minimum, broken grid). Track
  // touches, not net changes — undoing a value back to its original still
  // counts as a touch and keeps Save enabled (an already-tested invariant).
  const partial = buildPartial(changes);
  const boundsInverted = view.minCell > view.maxCell;
  const canSave = computeSaveEnabled({
    diffKeys: Object.keys(partial),
    minCell: view.minCell,
    maxCell: view.maxCell,
  });

  const pickSegment = (key, value) =>
    setChanges((prev) =>
      key === "preset" ? pickPreset(prev, value) : setValue(prev, key, value),
    );
  const pickSlider = (key, value) =>
    setChanges((prev) => setValue(prev, key, value));

  const save = () => {
    if (busy) return;
    setBusy(true);
    const scope = pageName != null && applyToPage ? "page" : "global";
    // The container decides what happens next (close the modal on
    // success, keep it open on failure); the form only guards double-saves.
    Promise.resolve(onSave(buildPartial(changes), scope)).finally(() =>
      setBusy(false),
    );
  };

  // ── Task 6.2: presets ─────────────────────────────────────────────────────
  // The snapshot reads the CURRENT view (pending diff layered over the merged
  // config the form rendered) but never touches what the main Save emits —
  // 6.1's smallest-diff invariant on the save path is untouched.
  const presetsReady =
    Array.isArray(presets) &&
    typeof onSavePreset === "function" &&
    typeof onApplyPreset === "function" &&
    typeof onDeletePreset === "function";
  // The page scope is only ever snapshotted/applied when a real, visible page
  // backs the form (same pageName gate as the "Apply to this page" toggle).
  const snapshotPageId = pageName != null ? pageId ?? null : null;
  // The preset's effective scope is the SAME toggle that routes the main Save —
  // reused here, no new state: a page-scoped preset writes only that page, a
  // global-scoped preset writes only the deck defaults (buildPresetSnapshot
  // routes by this and never emits both scopes).
  const presetScope = pageName != null && applyToPage ? "page" : "global";

  const [presetName, setPresetName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState("");
  // Two-tap inline delete confirm: the first tap flips the label to "Really?"
  // for 3s (non-modal, no window.confirm — ruling 5).
  const [deleteArmed, setDeleteArmed] = useState(false);
  const deleteArmTimerRef = useRef(null);
  const disarmDelete = () => {
    clearTimeout(deleteArmTimerRef.current);
    setDeleteArmed(false);
  };
  // The arm timer must not outlive the panel (the modal closes on save).
  useEffect(
    () => () => clearTimeout(deleteArmTimerRef.current),
    [],
  );
  // A deleted/unloaded preset cannot stay selected. Derived at render — the
  // container filters the row out of `presets`, so the picker simply reads
  // the placeholder again; no effect-write-back needed (react-hooks rule).
  const selectedStillPresent =
    presetsReady &&
    selectedPresetId !== "" &&
    presets.some((p) => p.id === selectedPresetId);
  const effectiveSelectedId = selectedStillPresent ? selectedPresetId : "";

  const snapshot = buildPresetSnapshot(
    changes,
    initialConfig,
    snapshotPageId,
    pageStoredConfig,
    presetScope,
  );
  const cleanName = sanitizePresetName(presetName);
  // Disabled when the name (trimmed) is empty, when neither scope has
  // anything to say, or while the bounds are inverted (same guard as Save —
  // a preset must not smuggle an impossible minCell > maxCell state).
  const canSavePreset =
    presetsReady &&
    cleanName != null &&
    Object.keys(snapshot).length > 0 &&
    !boundsInverted &&
    !presetBusy;
  const selectedPreset = selectedStillPresent
    ? presets.find((p) => p.id === effectiveSelectedId) ?? null
    : null;

  const savePreset = () => {
    if (!canSavePreset) return;
    setPresetBusy(true);
    // Reset the name input on success (ledger ruling); a failed save keeps
    // the typed name so the user can retry. The busy flag releases when the
    // container's promise settles — the form owns no fetch but does own its
    // double-tap guard.
    Promise.resolve(onSavePreset(cleanName, snapshot))
      .then((ok) => {
        if (ok !== false) setPresetName("");
      })
      .finally(() => setPresetBusy(false));
  };

  const applyPresetFromPicker = (event) => {
    // Reject a second apply while one is already in flight — the container's
    // onApplyPreset is an async Promise that awaits every write (App.jsx /
    // DesktopApp.jsx), so presetBusy is the authoritative busy signal. Without
    // the guard two overlapping applies race each other's writes.
    if (presetBusy) return;
    const id = event.target.value;
    setSelectedPresetId(id);
    disarmDelete();
    if (!id) return;
    const preset = presets.find((p) => p.id === id);
    if (!preset) return;
    // "immediately invoke applyPreset(preset, currentPageId)" — ruling 5.
    // If every write fails the container resolves false: put the picker back
    // on the placeholder rather than show an applied preset it did not apply.
    setPresetBusy(true);
    Promise.resolve(onApplyPreset(preset, snapshotPageId))
      .then((ok) => {
        if (ok === false) setSelectedPresetId("");
      })
      .finally(() => setPresetBusy(false));
  };

  const tapDelete = () => {
    if (!selectedPreset || presetBusy) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      clearTimeout(deleteArmTimerRef.current);
      deleteArmTimerRef.current = setTimeout(() => setDeleteArmed(false), 3000);
      return;
    }
    disarmDelete();
    setPresetBusy(true);
    Promise.resolve(onDeletePreset(selectedPreset.id)).finally(
      () => setPresetBusy(false),
    );
  };

  const presetLabels = {
    compact: "Compact",
    balanced: "Balanced",
    large: "Large",
    custom: "Custom",
  };

  return (
    <div style={styles.form}>
      <div style={styles.caption}>Deck layout</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Segmented
          label="Columns"
          options={[
            ["auto", "Automatic"],
            ["custom", "Custom columns"],
          ]}
          value={view.mode}
          onPick={(v) => pickSegment("mode", v)}
        />
        {/* Why there is no orientation control (spec §6: storing
            per-orientation intents was rejected as redundant state). */}
        <span style={styles.hint}>
          Responsive — the deck re-packs to fit the current screen at every
          orientation.
        </span>
        {view.mode === "custom" ? (
          <SliderRow
            label="Preferred columns"
            min={COLS_MIN}
            max={COLS_MAX}
            unit=""
            value={view.cols}
            onChange={(v) => pickSlider("cols", v)}
            hint="Preferred columns are a maximum; narrower screens use fewer."
          />
        ) : null}
      </div>

      <Segmented
        label="Tile size"
        options={PRESET_CHOICES.map((p) => [p, presetLabels[p] ?? p])}
        value={view.preset}
        onPick={(v) => pickSegment("preset", v)}
      />
      {view.preset === "custom" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <SliderRow
            label="Smallest tile"
            min={MIN_CELL_MIN}
            max={MIN_CELL_MAX}
            unit="px"
            value={view.minCell}
            onChange={(v) => pickSlider("minCell", v)}
          />
          <SliderRow
            label="Largest tile"
            min={MAX_CELL_MIN}
            max={MAX_CELL_MAX}
            unit="px"
            value={view.maxCell}
            onChange={(v) => pickSlider("maxCell", v)}
          />
          <SliderRow
            label="Gap"
            min={GAP_MIN}
            max={GAP_MAX}
            unit="px"
            value={view.gap}
            onChange={(v) => pickSlider("gap", v)}
          />
          {boundsInverted ? (
            <span style={styles.hint}>maxCell must be at least minCell.</span>
          ) : null}
        </div>
      ) : null}

      {pageName != null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            role="switch"
            aria-checked={applyToPage}
            aria-label={`Apply to this page (${pageName})`}
            style={styles.toggleTrack(applyToPage)}
            onClick={() => setApplyToPage((v) => !v)}
          >
            <span style={styles.toggleThumb(applyToPage)} />
          </button>
          <span style={styles.hint}>
            Apply to this page — <strong>{pageName}</strong>. Off saves
            deck-wide for every page.
          </span>
        </div>
      ) : null}

      <button
        type="button"
        style={styles.save}
        onClick={save}
        disabled={busy || !canSave}
      >
        {busy ? "Saving…" : "Save"}
      </button>

      {/* Task 6.2 — the Presets section, at the BOTTOM of the form (after the
          Apply-to-this-page controls and Save), rendered only when the
          container provided the preset props. */}
      {presetsReady ? (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 8,
            borderTop: "1px solid #22222a",
            paddingTop: 10,
          }}
        >
          <div style={styles.caption}>Presets</div>
          {/* D4 copy — MANDATORY VERBATIM per the Phase 6 ruling; reviewers
              fail this task if it is softened or reworded. */}
          <span style={styles.hint}>
            Presets save layout settings and responsive behavior. They do NOT
            save tile placements.
          </span>

          {/* Save-as-preset: snapshot the CURRENT view; gated on a trimmed
              non-empty name AND at least one scope with keys to say. */}
          <div style={styles.presetRow}>
            <input
              type="text"
              value={presetName}
              onChange={(e) => setPresetName(e.target.value)}
              aria-label="New preset name"
              placeholder="Name this preset"
              maxLength={PRESET_NAME_MAX}
              style={styles.presetInput}
            />
            <button
              type="button"
              style={styles.presetButton(false)}
              onClick={savePreset}
              disabled={!canSavePreset}
            >
              {presetBusy ? "Saving…" : "Save as preset"}
            </button>
          </div>

          {/* Apply-preset picker: saved presets newest-created first (the
              container sorted them); picking one fires the container's apply
              immediately. */}
          <select
            aria-label="Apply a preset"
            value={effectiveSelectedId}
            onChange={applyPresetFromPicker}
            disabled={presetBusy}
            style={styles.presetSelect}
          >
            <option value="">
              {presets.length ? "Select a preset…" : "No presets saved yet"}
            </option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          {/* Delete: first tap arms ("Really?" for 3s), second tap deletes.
              Non-modal — the disconnect-confirm dialog is overkill here. */}
          {selectedPreset ? (
            <button
              type="button"
              style={styles.presetButton(deleteArmed)}
              onClick={tapDelete}
              disabled={presetBusy}
            >
              {deleteArmed ? "Really?" : "Delete preset"}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

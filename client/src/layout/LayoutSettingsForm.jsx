// Phase 6, Task 6.1 — the layout settings form, shared by the phone's
// ControlSheet panel and the desktop ProfileMenu modal. It is a PURE
// CONTROLLED component: no fetch, no toast, no routing — the container owns
// the HTTP call and its feedback. It renders a full merged engine settings
// object (mergeLayout's output) and calls onSave(partial, scope) where
// `partial` contains ONLY the keys the user actively touched (explicit nulls
// clear a key at the target scope) and scope is "global", or "page" only
// while "Apply to this page" is on with a real page behind it. All the diff
// rules live in the pure layoutForm.js module beside it, unit-tested without
// a DOM.
import { useState } from "react";
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
  buildPartial,
  computeSaveEnabled,
  initialValues,
  pickPreset,
  setValue,
} from "./layoutForm.js";

// Palette mirrors ControlSheet's dark tokens (#1a1a22 fills, #2a2a35 hairlines,
// #3b82f6 accent) so the form reads as part of the sheet, not a web form.
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

export default function LayoutSettingsForm({ initialConfig, pageName, onSave }) {
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
    // The container decides what happens next (close the sheet/modal on
    // success, keep it open on failure); the form only guards double-saves.
    Promise.resolve(onSave(buildPartial(changes), scope)).finally(() =>
      setBusy(false),
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
    </div>
  );
}

/**
 * panelParts.jsx  —  client/src/widgets/panelParts.jsx
 *
 * The property-drawer primitives used by the widget drawer. Components only, so
 * React Fast Refresh stays happy; the non-component helpers live in
 * panelHelpers.js.
 *
 * These mirror what PropertyPanel uses inside DesktopApp.jsx rather than
 * importing from it, because DesktopApp exports a single component and sharing
 * would mean either breaking that or refactoring working code.
 */
export function Field({ label, children }) {
  return (
    <div style={styles.field}>
      <label style={styles.fieldLabel}>{label}</label>
      {children}
    </div>
  );
}

export function Toggle({ value, onChange, disabled = false }) {
  return (
    <div
      role="switch"
      aria-checked={!!value}
      onClick={() => !disabled && onChange(!value)}
      style={{
        width: 34,
        height: 19,
        borderRadius: 10,
        flexShrink: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.4 : 1,
        background: value ? "#3d8fd6" : "#2b2b2b",
        position: "relative",
        transition: "background 0.15s ease",
      }}
    >
      <span
        style={{
          position: "absolute",
          top: 2,
          left: value ? 17 : 2,
          width: 15,
          height: 15,
          borderRadius: "50%",
          background: "#fff",
          transition: "left 0.15s ease",
        }}
      />
    </div>
  );
}

const styles = {
  field: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    minWidth: 0,
  },
  fieldLabel: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.4,
    textTransform: "uppercase",
    color: "#5a5a5a",
  },
};

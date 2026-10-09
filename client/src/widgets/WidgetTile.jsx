/**
 * WidgetTile.jsx  —  client/src/widgets/WidgetTile.jsx
 *
 * The chrome every live tile shares: the status dot, the label, the stale
 * banner, and the body delegated to the type's renderer. Used by both the phone
 * deck and the desktop editor, so a tile looks the same wherever it appears.
 *
 * This component is presentation only. It renders the last frame it was given
 * and knows nothing about the socket — which is what makes a vanished host a
 * matter of one frame with `stale: true` rather than a loading state.
 */
import { Icon } from "../icons.jsx";
import { statusLabel, formatLastSeen, formatClock, isProblemStatus } from "./format.js";

const STATUS_COLORS = {
  online: "#4ade80",
  connecting: "#fbbf24",
  auth_error: "#f87171",
  unreachable: "#f87171",
  offline: "#f87171",
  unavailable: "#a1a1aa",
};

const STATUS_TITLES = {
  auth_error: "Authentication failed — check the key and username",
  unreachable: "Host did not answer in time",
  offline: "Host is unreachable",
  unavailable: "This widget's data source is missing or disabled",
};

export function WidgetTile({ widget, data = {}, sources, selected, onSelect, children }) {
  const accent = widget.color || "#185FA5";
  // A bound tile starts as CONNECTING until the first snapshot arrives. It must
  // never default to "online" just because local data is what happens to be on
  // hand — that is how local numbers end up presented under a remote host.
  const status = data.status || (widget.source_id ? "connecting" : "online");
  const stale = !!data.stale;
  const problem = stale || isProblemStatus(status);
  const dot = STATUS_COLORS[status] || STATUS_COLORS.offline;

  // Normalised here, not just at the fetch: this component is rendered for every
  // tile on every page, so a payload that is not a list must not be able to take
  // the whole deck down. A phone that gets a 401 object instead of an array used
  // to crash the render the moment a widget page appeared.
  const known = Array.isArray(sources) ? sources : [];
  const source = widget.source_id
    ? known.find((s) => s.id === widget.source_id)
    : null;

  // "This PC" is a claim, not a default. A tile bound to a host whose record has
  // not loaded yet must not be labelled local — that is what made a remote tile
  // look like it had forgotten its source after a restart. It says "Remote host"
  // for the moment the fetch takes to land, and never claims otherwise.
  const hostLine = source
    ? `${source.host}:${source.port || 22}`
    : widget.source_id
      ? data.lastError || "Remote host"
      : "This PC";

  return (
    <div
      onClick={onSelect ? (e) => { e.stopPropagation(); onSelect(widget); } : undefined}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        borderRadius: 8,
        overflow: "hidden",
        userSelect: "none",
        cursor: onSelect ? "pointer" : "default",
        // Selected reads the same way a selected key does, and a stale tile is
        // dimmed rather than hidden: the numbers are last known, not wrong.
        background: `linear-gradient(160deg, ${accent}24 0%, #1c1c1c 100%)`,
        border: `1.5px solid ${selected ? "#3d8fd6" : problem ? "#4a2a10" : `${accent}55`}`,
        boxShadow: selected ? "0 0 0 3px rgba(79,128,255,0.2)" : "none",
        opacity: stale ? 0.82 : 1,
        transition: "border 0.12s, box-shadow 0.12s, opacity 0.2s",
        display: "flex",
        flexDirection: "column",
        padding: "10px 11px 8px",
        gap: 4,
        fontFamily: "var(--font-sans)",
      }}
    >
      {/* Header: status dot, host, label */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <span
          title={STATUS_TITLES[status] || statusLabel(status)}
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            flexShrink: 0,
            background: dot,
            boxShadow: problem ? `0 0 6px ${dot}` : "none",
          }}
        />
        <span
          style={{
            fontSize: 9,
            fontWeight: 600,
            color: problem ? "#fb923c" : "var(--text-muted)",
            letterSpacing: 0.2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
          title={hostLine}
        >
          {hostLine}
        </span>
        <span style={{ marginLeft: "auto", fontSize: 8, fontWeight: 700, color: "#4b4b4b", flexShrink: 0 }}>
          {statusLabel(status)}
        </span>
      </div>

      {/* Tile label */}
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          color: "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {widget.label || "Widget"}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>{children}</div>

      {/* Offline footer — the state the user asked for when a host is asleep */}
      {stale && (
        <div
          style={{
            borderTop: "1px solid rgba(255,255,255,0.06)",
            paddingTop: 4,
            fontSize: 8.5,
            fontWeight: 600,
            color: "#fb923c",
            display: "flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <Icon name="disconnected" size={9} />
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            Last seen {data.lastSeen ? formatClock(data.lastSeen) : "never"}
            {data.lastSeen ? ` · ${formatLastSeen(data.lastSeen)}` : ""}
          </span>
        </div>
      )}
    </div>
  );
}

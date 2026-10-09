/**
 * SystemMonitorWidget.jsx  —  client/src/widgets/SystemMonitorWidget.jsx
 *
 * The first live widget. Renders only the metrics the widget was configured to
 * show *and* the source can actually measure, so a machine with no temperature
 * sensors never grows an empty row.
 */
import { visibleMetrics } from "./registry.js";
import {
  formatBytes,
  formatPercent,
  formatRate,
  formatTemperature,
  formatUptime,
} from "./format.js";

/** How many disk rows a tile shows before collapsing to a count. */
const MAX_DISK_ROWS = 2;

function Row({ label, value, hint, warn }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 8,
        fontSize: 10,
        lineHeight: 1.5,
        minWidth: 0,
      }}
    >
      <span style={{ color: "#5a5a5a", fontWeight: 600, letterSpacing: 0.3, flexShrink: 0 }}>
        {label}
      </span>
      <span
        style={{
          color: warn ? "#f87171" : "var(--text-secondary)",
          fontWeight: 700,
          fontVariantNumeric: "tabular-nums",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={hint || value}
      >
        {value}
      </span>
    </div>
  );
}

/** A thin bar, because a number alone makes a busy tile hard to scan. */
function Meter({ percent, warn }) {
  return (
    <span
      style={{
        display: "block",
        width: "100%",
        height: 3,
        borderRadius: 2,
        background: "rgba(255,255,255,0.10)",
        overflow: "hidden",
        marginTop: 2,
      }}
    >
      <span
        style={{
          display: "block",
          height: "100%",
          borderRadius: 2,
          transformOrigin: "left center",
          transform: `scaleX(${Math.max(0, Math.min(100, percent)) / 100})`,
          background: warn ? "#f87171" : "rgba(255,255,255,0.55)",
          transition: "transform 0.12s ease",
        }}
      />
    </span>
  );
}

export function SystemMonitorWidget({ widget, data }) {
  const metrics = visibleMetrics(widget, data);
  if (metrics.length === 0)
    return (
      <div style={{ fontSize: 9.5, color: "#4b4b4b", paddingTop: 8, textAlign: "center" }}>
        No metrics reported
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      {metrics.map((metric) => (
        <MetricBlock key={metric.id} metric={metric.id} data={data} />
      ))}
    </div>
  );
}

function MetricBlock({ metric, data }) {
  switch (metric) {
    case "cpu":
      return (
        <div>
          <Row
            label="CPU"
            value={formatPercent(data.cpu)}
            warn={Number(data.cpu) > 85}
          />
          <Meter percent={Number(data.cpu) || 0} warn={Number(data.cpu) > 85} />
        </div>
      );

    case "memory":
      return (
        <div>
          <Row
            label="RAM"
            value={`${formatBytes(data.memory.used)} / ${formatBytes(data.memory.total)}`}
            hint={`${Math.round(data.memory.percent)}% used`}
          />
          <Meter percent={data.memory.percent} warn={data.memory.percent > 85} />
        </div>
      );

    case "disk": {
      // A tile is small and a Linux box can report a dozen mounts (subst'd
      // drives and bind mounts multiply them on Windows too), so show the
      // fullest two and name the rest as a count.
      const disks = [...data.disks].sort((a, b) => (b.percent || 0) - (a.percent || 0));
      const shown = disks.slice(0, MAX_DISK_ROWS);
      const extra = disks.length - shown.length;
      return (
        <>
          {shown.map((disk, i) => (
            <div key={`${disk.mount}-${i}`}>
              <Row
                label={shortMount(disk.mount)}
                value={`${formatPercent(disk.percent)} of ${formatBytes(disk.total)}`}
                warn={disk.percent > 90}
              />
              <Meter percent={disk.percent} warn={disk.percent > 90} />
            </div>
          ))}
          {extra > 0 && (
            <Row label="MORE" value={`+${extra} volume${extra === 1 ? "" : "s"}`} />
          )}
        </>
      );
    }

    case "network": {
      const rx = data.network.rx;
      const tx = data.network.tx;
      // Both directions in one row, download first because that is the bigger
      // number on most machines.
      const parts = [];
      if (typeof rx === "number") parts.push(`↓ ${formatRate(rx)}`);
      if (typeof tx === "number") parts.push(`↑ ${formatRate(tx)}`);
      return <Row label="NET" value={parts.join("   ") || "—"} />;
    }

    case "uptime":
      return <Row label="UPTIME" value={formatUptime(data.uptime)} />;

    case "temperature":
      return <Row label="TEMP" value={formatTemperature(data.temperature)} />;

    case "containers": {
      const c = data.containers;
      // An explicit failure renders as an unavailable row, never as a hidden
      // one: "docker is not installed" is information the user needs.
      if (c.error)
        return (
          <Row
            label="DOCKER"
            value={c.error}
            warn
            hint={c.error}
          />
        );
      const bits = [`${c.running ?? 0} up`];
      if (typeof c.stopped === "number") bits.push(`${c.stopped} down`);
      if (typeof c.unhealthy === "number" && c.unhealthy > 0) bits.push(`${c.unhealthy} bad`);
      return (
        <Row
          label="DOCKER"
          value={bits.join(" · ")}
          warn={Number(c.unhealthy) > 0}
        />
      );
    }

    default:
      return null;
  }
}

/** "/" and "/boot/efi" and "C:\\" all need to fit in a narrow label column. */
function shortMount(mount) {
  const m = String(mount || "/");
  if (m.length <= 12) return m;
  const parts = m.split(/[\\/]/).filter(Boolean);
  return `…/${parts[parts.length - 1] || m}`;
}


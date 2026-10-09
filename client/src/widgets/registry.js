/**
 * registry.js  —  client/src/widgets/registry.js
 *
 * The widget types the deck can hold, and the metrics a System Monitor can
 * show. Kept out of actionRegistry.js on purpose: an entry there becomes a
 * `buttons` row and is handed to executeAction at press time, which is exactly
 * what a live tile is not.
 */

export const WIDGET_TYPES = [
  {
    id: "system_monitor",
    name: "System Monitor",
    icon: "server",
    // The tile a drag from the library creates. 2x2 because the metric list is
    // the whole point of the widget and 1x1 cannot show more than one line.
    defaultSize: "2x2",
    defaultMetrics: ["cpu", "memory", "disk", "uptime"],
    description: "Live CPU, RAM, disk, network and uptime for this PC or a host over SSH",
  },
];

/**
 * Metrics a System Monitor understands, in display order. `has` decides
 * whether a row is drawn for a given snapshot, so a machine without
 * temperature sensors simply never shows that line.
 */
export const METRIC_REGISTRY = [
  {
    id: "cpu",
    label: "CPU",
    icon: "cpu",
    has: (s) => typeof s?.cpu === "number",
  },
  {
    id: "memory",
    label: "RAM",
    icon: "ram",
    has: (s) => !!s?.memory,
  },
  {
    id: "disk",
    label: "DISK",
    icon: "hard-drive",
    has: (s) => Array.isArray(s?.disks) && s.disks.length > 0,
  },
  {
    id: "network",
    label: "NET",
    icon: "network",
    has: (s) => !!s?.network && (typeof s.network.rx === "number" || typeof s.network.tx === "number"),
  },
  {
    id: "uptime",
    label: "UPTIME",
    icon: "timer",
    has: (s) => typeof s?.uptime === "number",
  },
  {
    id: "temperature",
    label: "TEMP",
    icon: "thermometer",
    has: (s) => typeof s?.temperature === "number",
  },
  {
    id: "containers",
    label: "DOCKER",
    icon: "container",
    // Present for real counts AND for an explicit error. An unavailable metric
    // must still occupy its row so the user can see why it is blank.
    has: (s) => !!s?.containers,
  },
];

export const WIDGET_METRIC_IDS = METRIC_REGISTRY.map((m) => m.id);

export const WIDGET_SIZES = [
  { value: "1x1", label: "1x1" },
  { value: "2x1", label: "2x1" },
  { value: "2x2", label: "2x2" },
];

export function widgetTypeById(id) {
  return WIDGET_TYPES.find((t) => t.id === id) || WIDGET_TYPES[0];
}

/** Metrics a widget shows, filtered to ones the source actually reports. */
export function visibleMetrics(widget, data) {
  const wanted = widget?.config?.metrics || METRIC_REGISTRY.map((m) => m.id);
  return METRIC_REGISTRY.filter((metric) => wanted.includes(metric.id) && metric.has(data));
}

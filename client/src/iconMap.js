/**
 * iconMap.js — icon name → Lucide component lookups.
 *
 * Kept separate from icons.jsx so that file exports only components, which is
 * what React Fast Refresh requires.
 *
 * Icons are imported explicitly rather than via `import * as lucide`, so the
 * bundle only carries what is actually rendered.
 */
import {
  // action-registry icons (keys mirror the `icon` field in actionRegistry.js)
  AudioLines,
  ExternalLink,
  Keyboard,
  Mic,
  MicOff,
  Rocket,
  SlidersHorizontal,
  Terminal,
  Timer,
  Type,
  Volume1,
  Volume2,
  VolumeX,
  // interface chrome
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  Grip,
  Layers,
  Lock,
  MemoryStick,
  Monitor,
  Plus,
  Search,
  Settings,
  Smartphone,
  Trash2,
  Upload,
  Volume,
  WifiOff,
  X,
} from "lucide-react";

/** Rendered when an action name has no mapping, so nothing renders blank. */
export const FallbackIcon = Layers;

export const ACTION_ICONS = {
  "audio-lines": AudioLines,
  "external-link": ExternalLink,
  keyboard: Keyboard,
  mic: Mic,
  "mic-off": MicOff,
  rocket: Rocket,
  "sliders-horizontal": SlidersHorizontal,
  terminal: Terminal,
  timer: Timer,
  type: Type,
  "volume-1": Volume1,
  "volume-2": Volume2,
  "volume-x": VolumeX,
};

/** Interface chrome, addressed by a stable semantic name rather than a glyph. */
export const Icons = {
  add: Plus,
  check: Check,
  chevronDown: ChevronDown,
  chevronRight: ChevronRight,
  close: X,
  cpu: Cpu,
  delete: Trash2,
  desktop: Monitor,
  disconnected: WifiOff,
  drag: Grip,
  guarded: Lock,
  pages: Layers,
  phone: Smartphone,
  ram: MemoryStick,
  search: Search,
  settings: Settings,
  sound: Volume,
  upload: Upload,
};

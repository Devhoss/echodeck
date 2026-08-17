/**
 * icons.jsx — the icon vocabulary for both apps.
 *
 * Everything structural comes from Lucide: one family, one stroke weight, and
 * icons that inherit colour and scale with text. Emoji previously did this job,
 * but they render differently on every platform and cannot be recoloured or
 * sized reliably.
 *
 * Emoji remain legitimate as a *button's own icon* — that is user content the
 * person chose, not part of the interface.
 */
import { ACTION_ICONS, FallbackIcon, Icons } from "./iconMap.js";

/**
 * Icon for an action type, resolved from the registry's `icon` field. Falls
 * back to a neutral glyph rather than rendering nothing, so an unmapped action
 * is still visibly present instead of silently blank.
 *
 * Always decorative: action rows and keys carry their own visible text label.
 */
export function ActionIcon({ name, size = 16, ...rest }) {
  const Glyph = ACTION_ICONS[name] ?? FallbackIcon;
  return <Glyph size={size} strokeWidth={1.5} aria-hidden="true" {...rest} />;
}

/**
 * Interface icon by semantic name.
 *
 * Pass `label` when the icon is the only content of a control — it becomes the
 * accessible name. Without it the icon is treated as decorative and hidden from
 * assistive tech, which is correct when adjacent text already names the control.
 */
export function Icon({ name, size = 16, label, ...rest }) {
  const Glyph = Icons[name];
  if (!Glyph) return null;
  return (
    <Glyph
      size={size}
      strokeWidth={1.5}
      aria-hidden={label ? undefined : "true"}
      aria-label={label}
      role={label ? "img" : undefined}
      {...rest}
    />
  );
}

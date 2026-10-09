/**
 * panelHelpers.js  —  client/src/widgets/panelHelpers.js
 *
 * Non-component helpers shared by the widget drawer. Split from panelParts.jsx
 * because a file that mixes components and functions breaks React Fast Refresh
 * (eslint react-refresh/only-export-components).
 *
 * COLORS is a copy of the palette in DesktopApp.jsx. WidgetPanel cannot import
 * it from there — DesktopApp exports a single component, so its constants are
 * not reachable without breaking that same rule — and re-declaring a palette is
 * cheaper than refactoring the existing editor to export one.
 */

import { useEffect, useRef, useCallback } from "react";

export const COLORS = [
  "#5B4FCF",
  "#0F6E56",
  "#185FAA",
  "#854F0B",
  "#7C1D3F",
  "#1D5C7C",
  "#2D6B2D",
  "#6B2D2D",
];

// Mirrors DesktopApp's useCoalescedPatch: the callback is a dependency rather
// than a ref, because writing to a ref during render is a React error (and
// eslint catches it). A colour picker streams an event per pointer move, and
// each one would otherwise re-render the whole deck.
export function useCoalescedPatch(onPatch, frameMs = 16) {
  const timerRef = useRef(0);
  const pendingRef = useRef(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  return useCallback(
    (patch) => {
      pendingRef.current = { ...pendingRef.current, ...patch };
      if (timerRef.current) return;
      timerRef.current = setTimeout(() => {
        timerRef.current = 0;
        const queued = pendingRef.current;
        pendingRef.current = null;
        if (queued) onPatch(queued);
      }, frameMs);
    },
    [onPatch, frameMs],
  );
}

// Phase 1, Task 1.2: measurement hook feeding the pure engine in deckLayout.js.
// Consumes an external container ref owned by the caller (App.jsx's deckRef /
// DesktopApp's canvas ref pass it in) and returns the current
// computeDeckLayout contract, or null before the first successful measure.
// Dependencies: React hooks only.
import { useLayoutEffect, useRef, useState } from "react";
import { computeDeckLayout } from "./deckLayout.js";

export function useDeckLayout(containerRef, { items, settings }) {
  const [layout, setLayout] = useState(null);

  // The recompute is keyed on what the engine actually reads: item count and
  // spans, plus settings values. Live metric data rides on items without
  // touching either, so widget updates never re-trigger layout (§11).
  const itemsKey = JSON.stringify(items.map((it) => it.size));
  const settingsKey = JSON.stringify(settings ?? null);

  // Latest items/settings for the measure closure, synced during commit —
  // never during render (writing a ref in render is a React error, and the
  // lint rule that caught it in widgets/panelHelpers.js applies the same way).
  const liveRef = useRef({ items, settings });

  // Promote the observed element to state: a ref object's identity is
  // permanently stable, so the measuring effect could never notice the
  // container attaching, detaching, or being swapped for a different node.
  // The no-deps commit effect below re-runs the measuring effect (via this
  // state) whenever containerRef.current actually changes.
  const [element, setElement] = useState(null);

  // Polling containerRef.current on every commit is the only way to observe a
  // caller-owned ref whose object identity never changes (attach/detach/swap).
  // setElement's Object.is bailout makes the depsless setState idempotent, so
  // the infinite-chain this heuristic warns about cannot occur.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    liveRef.current = { items, settings };
    // Polled on every commit; setState bails out via Object.is when the node
    // is unchanged, so this costs no extra render in the steady state.
    setElement(containerRef?.current ?? null);
  });

  useLayoutEffect(() => {
    // No element (not yet mounted, or detached/swapped away): stop observing
    // and keep the last layout, so a transient swap never blanks the deck.
    if (!element) return;

    let frame = 0;
    let lastKey = null;

    const measure = () => {
      const cs = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      // Content box, not border box: the rect includes padding, which
      // historically made tiles a few px too big and pushed the last row
      // under the container's clip (the App.jsx padding trap).
      const width = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const height = box.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      const key = `${width}|${height}|${itemsKey}|${settingsKey}`;
      if (key === lastKey) return; // inputs unchanged: no recompute, no setState
      lastKey = key;
      const live = liveRef.current;
      const next = computeDeckLayout({ width, height, items: live.items, settings: live.settings });
      // State keeps the same object when the layout VALUE is unchanged, so a
      // resize tick that resolves to the same contract never re-renders the deck.
      setLayout((prev) => (prev && JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    };

    // rAF coalescing: bursts of resize/orientation events collapse into at
    // most one recompute per frame (same idea as useCoalescedPatch).
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };

    // Layout effect, not effect: the first measure runs synchronously so the
    // very next paint already uses the right contract, never a frame of the
    // old size (the reason App.jsx chose useLayoutEffect).
    measure();

    // Belt and suspenders: ResizeObserver alone proved unreliable on phone
    // rotation — the viewport changes without the box reporting in time —
    // so the window events back it up. All three paths call the same schedule.
    const ro = new ResizeObserver(schedule);
    ro.observe(element);
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
    };
    // Keyed on the promoted `element` (not the stable containerRef identity) so
    // attach / detach / swap tears down the old observation and re-observes the
    // new node; it also re-runs when the layout-relevant keys change.
  }, [element, itemsKey, settingsKey]);

  return layout;
}

// Playwright viewport harness (Task 7.1) — a pure in-memory stand-in for the
// ReconnectingWebSocket the phone deck normally opens. Instantiated only when
// `?mock=1` is on the URL (see mockMode.js); it NEVER touches the network: no
// WebSocket is constructed, no host traffic leaves the page. It exposes the
// exact surface the App.jsx connect site wires — addEventListener /
// removeEventListener / send / close / reconnect / readyState — fires `open`
// so the status becomes "connected", delivers the canned fixture frames
// asynchronously, keeps the app's 8-second staleness watchdog quiet with a
// periodic `stats` tick, and records every frame the app sends so the spec can
// assert the edit-mode Save diff reaches the socket.
//
// The spec reaches it through `window.__MOCK_WS__` (`.sent`, `.pushFrame`).
import fixture from "../../test/viewport/fixtures/deck.json";
import { isMockMode } from "./mockMode.js";

// The real host pushes stats every ~3s; matching that cadence keeps
// lastMessageAtRef fresh so reconnectIfStale never fires during a run.
const STATS_EVERY_MS = 3000;

export function createMockSocket() {
  const listeners = new Map();
  const sent = [];
  let interval = null;
  const socket = {
    // Mock-surface extras the harness reads (not part of the RWS surface):
    sent,
    url: "mock://viewport-harness",
    pushFrame: (frame) => {
      if (socket.readyState !== 1) return;
      dispatch("message", { data: JSON.stringify(frame) });
    },
    // ── ReconnectingWebSocket surface used by the App.jsx connect site ──
    readyState: 0,
    addEventListener: (type, fn) => {
      const list = listeners.get(type) || [];
      listeners.set(type, [...list, fn]);
    },
    removeEventListener: (type, fn) => {
      const list = listeners.get(type) || [];
      listeners.set(
        type,
        list.filter((f) => f !== fn),
      );
    },
    send: (data) => {
      sent.push(String(data));
    },
    close: () => {
      socket.readyState = 3;
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
      dispatch("close", { code: 1000, reason: "mock close" });
    },
    // App calls reconnect(delay, reason) from its watchdog/press paths; the
    // mock is always healthy, so re-open and re-deliver the snapshot instead.
    reconnect: () => {
      dispatch("open", {});
      socket.pushFrame(fixture.state);
    },
  };

  function dispatch(type, event) {
    for (const fn of [...(listeners.get(type) || [])]) fn(event);
  }

  // The effect registers its listeners synchronously after construction, so
  // `open` and the first frames must ride a macrotask, not the current turn.
  setTimeout(() => {
    if (socket.readyState === 3) return;
    socket.readyState = 1;
    dispatch("open", {});
    socket.pushFrame(fixture.state);
    socket.pushFrame(fixture.ticks[0]);
    socket.pushFrame(fixture.stats);
    interval = setInterval(() => {
      socket.pushFrame(fixture.stats);
    }, STATS_EVERY_MS);
  }, 0);

  window.__MOCK_WS__ = socket;
  // The spec reads the SAME canned frames back off the page instead of
  // re-parsing the fixture file, so ids/sizes/bounds can never drift between
  // what the app rendered and what the spec asserts.
  window.__MOCK_FIXTURE__ = fixture;
  // Only ever reached behind the flag; assert that so a wiring mistake in
  // App.jsx (calling this without ?mock=1) fails loudly instead of silently
  // swapping the production socket.
  if (!isMockMode()) {
    throw new Error("createMockSocket called without ?mock=1");
  }
  return socket;
}

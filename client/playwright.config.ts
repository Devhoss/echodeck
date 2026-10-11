// Task 7.1 — Playwright viewport-matrix harness config (client/).
//
// Harness shape (controller ruling #1): the REAL production bundle built by
// `npm run build`, served by `vite preview`, loaded with `?mock=1` — no
// parallel Vite entry, so the spec exercises exactly the code that ships.
//
// Lives in client/ next to package.json so `npm run test:viewport` and the
// webServer commands resolve against the client workspace.
import { defineConfig } from "@playwright/test";
// The frozen Phase-1 viewport matrix — the single source of truth; the spec
// runs once per project below, so every assertion executes at every size.
import { VIEWPORTS } from "./test/viewports.js";

const PORT = 4173;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./test/viewport",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "off",
    // The stub socket is pure in-memory; a real WebSocket attempt here would
    // mean the mock gate failed — the spec asserts none ever happens.
  },
  projects: VIEWPORTS.map((v) => ({
    name: `${v.name}-${v.w}x${v.h}`,
    use: { viewport: { width: v.w, height: v.h } },
  })),
  webServer: {
    // Build first so the suite always runs against the production bundle.
    // reuseExistingServer is forced false so every run — local included —
    // rebuilds and serves a FRESH dist; a leftover `vite preview` from a prior
    // build can never silently serve stale output. CI is unchanged (was already
    // starting its own server).
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});

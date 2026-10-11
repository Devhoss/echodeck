const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");
const {
  buildWidgetUpdate,
  buildSourceUpdate,
  deserializeWidget,
  widgetDefaults,
  sourceDefaults,
} = require("./widgets/widgetShape.js");
const { backfillSlots, applyReorder } = require("./itemOrder.js");
const { applyPageOrder } = require("./pageOrder.js");
const {
  BUTTON_SIZES,
  sanitizeLayoutConfig,
} = require("./layoutConfig.js");

const dbPath = path.join(
  os.homedir(),
  "AppData",
  "Roaming",
  "StreamDeck",
  "macro-deck.db",
);

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS pages (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    -- FEATURE: Key labels — a per-page preference rather than a deck-wide one,
    -- so turning labels on for one profile leaves the others untouched.
    show_labels INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS buttons (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    label TEXT NOT NULL,
    icon TEXT DEFAULT '⚡',
    icon_data TEXT DEFAULT NULL,
    color TEXT DEFAULT '#5B4FCF',
    position INTEGER DEFAULT 0,
    action_type TEXT DEFAULT 'keystroke',
    action_value TEXT DEFAULT '',
    size TEXT DEFAULT '1x1',
    is_toggle INTEGER DEFAULT 0,
    toggle_state INTEGER DEFAULT 0,
    toggle_action_type TEXT DEFAULT 'keystroke',
    toggle_action_value TEXT DEFAULT '',
    actions TEXT DEFAULT NULL,
    button_mode TEXT DEFAULT 'single',
    switch_actions_a TEXT DEFAULT NULL,
    switch_actions_b TEXT DEFAULT NULL,
    switch_state INTEGER DEFAULT 0,
    sound_file TEXT DEFAULT NULL,
    -- FEATURE: Soundboard routing — 'phone' | 'pc' | 'both'
    sound_target TEXT DEFAULT 'phone',
    audio_device TEXT DEFAULT NULL,
    -- FEATURE: Hold to confirm — guard destructive buttons (shutdown, restart)
    -- behind a sustained press instead of a single tap.
    require_confirm INTEGER DEFAULT 0,
    FOREIGN KEY (page_id) REFERENCES pages(id)
  );

  -- FEATURE: Settings — global key/value store (PC output device name lives here)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- FEATURE: Pairing — long-lived per-device credentials. The pairing code in
  -- the QR still rotates every launch so old screenshots expire, but a device
  -- that has already paired keeps its own token and survives restarts.
  CREATE TABLE IF NOT EXISTS paired_devices (
    id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    name TEXT,
    created_at TEXT NOT NULL,
    last_seen TEXT
  );

  CREATE TABLE IF NOT EXISTS profile_rules (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 100,
    logic TEXT DEFAULT 'AND',
    conditions TEXT NOT NULL DEFAULT '[]',
    switch_delay INTEGER DEFAULT 0,
    FOREIGN KEY (page_id) REFERENCES pages(id)
  );

  -- FEATURE: Live widgets — a persistent tile that receives data instead of an
  -- action. source_id is null for the local machine, otherwise a
  -- widget_sources row, so several tiles can share one collector.
  CREATE TABLE IF NOT EXISTS widgets (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    type TEXT DEFAULT 'system_monitor',
    position INTEGER DEFAULT 0,
    size TEXT DEFAULT '2x2',
    label TEXT DEFAULT 'Widget',
    icon TEXT DEFAULT 'server',
    color TEXT DEFAULT '#185FA5',
    source_id TEXT DEFAULT NULL,
    config TEXT DEFAULT '{"metrics":["cpu","memory","disk","uptime"]}',
    FOREIGN KEY (page_id) REFERENCES pages(id)
  );

  -- FEATURE: Live widgets — a data source, not a widget. Remote hosts live
  -- here so a second tile can watch the same machine over one connection.
  -- auth holds an encrypted passphrase blob (secureStore.js); there is
  -- deliberately no password column anywhere in this schema.
  CREATE TABLE IF NOT EXISTS widget_sources (
    id TEXT PRIMARY KEY,
    kind TEXT DEFAULT 'ssh',
    name TEXT NOT NULL,
    host TEXT DEFAULT '',
    port INTEGER DEFAULT 22,
    username TEXT DEFAULT '',
    key_path TEXT DEFAULT '',
    auth TEXT DEFAULT NULL,
    use_agent INTEGER DEFAULT 0,
    refresh_ms INTEGER DEFAULT 10000,
    enabled INTEGER DEFAULT 1,
    created_at TEXT
  );

  -- FEATURE: Responsive layout — saved grid-tuning sets (plan D7). The config
  -- is one JSON document {defaults:{...}, pages:{[pageId]:{...}}} so applying
  -- a preset is a single read; it is sanitized on the way in (layoutConfig.js)
  -- and nothing but that JSON ever lives in this table.
  CREATE TABLE IF NOT EXISTS layout_presets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT NOT NULL,
    created_at TEXT
  );
`);

// --- Migrations ---
const existingCols = db.pragma("table_info(buttons)").map((c) => c.name);

if (!existingCols.includes("size"))
  db.exec(`ALTER TABLE buttons ADD COLUMN size TEXT DEFAULT '1x1'`);
if (!existingCols.includes("is_toggle"))
  db.exec(`ALTER TABLE buttons ADD COLUMN is_toggle INTEGER DEFAULT 0`);
if (!existingCols.includes("toggle_state"))
  db.exec(`ALTER TABLE buttons ADD COLUMN toggle_state INTEGER DEFAULT 0`);
if (!existingCols.includes("toggle_action_type"))
  db.exec(
    `ALTER TABLE buttons ADD COLUMN toggle_action_type TEXT DEFAULT 'keystroke'`,
  );
if (!existingCols.includes("toggle_action_value"))
  db.exec(`ALTER TABLE buttons ADD COLUMN toggle_action_value TEXT DEFAULT ''`);
if (!existingCols.includes("actions"))
  db.exec(`ALTER TABLE buttons ADD COLUMN actions TEXT DEFAULT NULL`);
if (!existingCols.includes("button_mode"))
  db.exec(`ALTER TABLE buttons ADD COLUMN button_mode TEXT DEFAULT 'single'`);
if (!existingCols.includes("switch_actions_a"))
  db.exec(`ALTER TABLE buttons ADD COLUMN switch_actions_a TEXT DEFAULT NULL`);
if (!existingCols.includes("switch_actions_b"))
  db.exec(`ALTER TABLE buttons ADD COLUMN switch_actions_b TEXT DEFAULT NULL`);
if (!existingCols.includes("switch_state"))
  db.exec(`ALTER TABLE buttons ADD COLUMN switch_state INTEGER DEFAULT 0`);
if (!existingCols.includes("sound_file"))
  db.exec(`ALTER TABLE buttons ADD COLUMN sound_file TEXT DEFAULT NULL`);
if (!existingCols.includes("sound_target"))
  db.exec(`ALTER TABLE buttons ADD COLUMN sound_target TEXT DEFAULT 'phone'`);
if (!existingCols.includes("audio_device"))
  db.exec(`ALTER TABLE buttons ADD COLUMN audio_device TEXT DEFAULT NULL`);
if (!existingCols.includes("require_confirm"))
  db.exec(`ALTER TABLE buttons ADD COLUMN require_confirm INTEGER DEFAULT 0`);

// FEATURE: Responsive layout — a page-scoped `slot` interleaves buttons and
// widgets into one authoritative order (plan D2); `position` becomes a
// server-derived dense rank within each kind, so old clients keep rendering.
// The backfill runs exactly once, in the branch that first adds the columns:
// it reproduces today's rendered order (buttons sorted, then widgets), so
// adopting it is visually a no-op. Idempotent by construction — a second
// startup finds both columns present and skips the whole branch.
const existingWidgetCols = db.pragma("table_info(widgets)").map((c) => c.name);
const needsButtonSlot = !existingCols.includes("slot");
const needsWidgetSlot = !existingWidgetCols.includes("slot");
if (needsButtonSlot || needsWidgetSlot) {
  if (needsButtonSlot)
    db.exec(`ALTER TABLE buttons ADD COLUMN slot INTEGER`);
  if (needsWidgetSlot)
    db.exec(`ALTER TABLE widgets ADD COLUMN slot INTEGER`);
  // `table` is itemOrder's own "buttons"|"widgets" literal, never user input,
  // so interpolating it into the UPDATE is safe.
  const applyBackfill = db.transaction((assignments) => {
    for (const a of assignments)
      db.prepare(`UPDATE ${a.table} SET slot=? WHERE id=?`).run(a.slot, a.id);
  });
  applyBackfill(
    backfillSlots(
      db
        .prepare(
          "SELECT id, page_id, position, rowid FROM buttons ORDER BY page_id, position, rowid",
        )
        .all(),
      db
        .prepare(
          "SELECT id, page_id, position, rowid FROM widgets ORDER BY page_id, position, rowid",
        )
        .all(),
    ),
  );
}

const existingRuleCols = db
  .pragma("table_info(profile_rules)")
  .map((c) => c.name);
if (!existingRuleCols.includes("switch_delay"))
  db.exec(
    `ALTER TABLE profile_rules ADD COLUMN switch_delay INTEGER DEFAULT 0`,
  );

// FEATURE: Key labels — the deck-wide `deck_show_labels` setting became a
// per-page flag. An existing deck keeps its labels by inheriting that value,
// and the setting is then deleted so a stale row cannot look like a live one.
const existingPageCols = db.pragma("table_info(pages)").map((c) => c.name);
if (!existingPageCols.includes("show_labels")) {
  db.exec(`ALTER TABLE pages ADD COLUMN show_labels INTEGER DEFAULT 0`);
  db.prepare("UPDATE pages SET show_labels=?").run(
    getSetting("deck_show_labels") === "1" ? 1 : 0,
  );
  db.prepare("DELETE FROM settings WHERE key=?").run("deck_show_labels");
}

// FEATURE: Responsive layout — per-page grid knobs as JSON text (plan D4) and
// the hidden flag marking the Unfiled page (plan D3). Additive only: an
// existing page with no layout_config is NULL, meaning "follow the global
// default", which is exactly the pre-feature behaviour.
if (!existingPageCols.includes("layout_config"))
  db.exec(`ALTER TABLE pages ADD COLUMN layout_config TEXT DEFAULT NULL`);
if (!existingPageCols.includes("hidden"))
  db.exec(`ALTER TABLE pages ADD COLUMN hidden INTEGER DEFAULT 0`);

// --- Seed ---
const pageCount = db.prepare("SELECT COUNT(*) as c FROM pages").get().c;
if (pageCount === 0) {
  db.prepare(
    `INSERT INTO pages (id, name, position, show_labels) VALUES ('page_main', 'Main', 0, 0)`,
  ).run();

  const insertBtn = db.prepare(`
    INSERT INTO buttons (
      id, page_id, label, icon, icon_data, color, position,
      action_type, action_value, size,
      is_toggle, toggle_state, toggle_action_type, toggle_action_value,
      actions, button_mode, switch_actions_a, switch_actions_b, switch_state,
      sound_file, sound_target, audio_device
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);

  [
    [
      "btn_1",
      "page_main",
      "Hello",
      "👋",
      null,
      "#5B4FCF",
      0,
      "type",
      "Hello!",
      "1x1",
      0,
      0,
      "keystroke",
      "",
      null,
      "single",
      null,
      null,
      0,
      null,
      "phone",
      null,
    ],
    [
      "btn_2",
      "page_main",
      "Copy",
      "📋",
      null,
      "#0F6E56",
      1,
      "keystroke",
      "ctrl+c",
      "1x1",
      0,
      0,
      "keystroke",
      "",
      null,
      "single",
      null,
      null,
      0,
      null,
      "phone",
      null,
    ],
    [
      "btn_3",
      "page_main",
      "Paste",
      "📄",
      null,
      "#0F6E56",
      2,
      "keystroke",
      "ctrl+v",
      "1x1",
      0,
      0,
      "keystroke",
      "",
      null,
      "single",
      null,
      null,
      0,
      null,
      "phone",
      null,
    ],
    [
      "btn_4",
      "page_main",
      "Save",
      "💾",
      null,
      "#185FA5",
      3,
      "keystroke",
      "ctrl+s",
      "1x1",
      0,
      0,
      "keystroke",
      "",
      null,
      "single",
      null,
      null,
      0,
      null,
      "phone",
      null,
    ],
    [
      "btn_5",
      "page_main",
      "Undo",
      "↩️",
      null,
      "#854F0B",
      4,
      "keystroke",
      "ctrl+z",
      "1x1",
      0,
      0,
      "keystroke",
      "",
      null,
      "single",
      null,
      null,
      0,
      null,
      "phone",
      null,
    ],
    [
      "btn_6",
      "page_main",
      "Redo",
      "↪️",
      null,
      "#854F0B",
      5,
      "keystroke",
      "ctrl+y",
      "1x1",
      0,
      0,
      "keystroke",
      "",
      null,
      "single",
      null,
      null,
      0,
      null,
      "phone",
      null,
    ],
  ].forEach((row) => insertBtn.run(...row));
}

// --- Settings ---
function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare(
    "INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  ).run(key, String(value));
}

// --- Pages ---
function getPages() {
  // FEATURE: Page reordering — `rowid` is the tie-break, so two rows sharing a
  // position (possible only after a partial historical write) keep a stable
  // relative order instead of an unspecified one.
  return db.prepare("SELECT * FROM pages ORDER BY position, rowid").all();
}
function createPage(id, name, position, show_labels = 0) {
  db.prepare(
    `INSERT INTO pages (id, name, position, show_labels) VALUES (?,?,?,?)`,
  ).run(id, name, position, show_labels ? 1 : 0);
  return getPage(id);
}
function getPage(id) {
  return db.prepare("SELECT * FROM pages WHERE id=?").get(id);
}
function deletePage(id) {
  db.prepare("DELETE FROM buttons WHERE page_id=?").run(id);
  db.prepare("DELETE FROM profile_rules WHERE page_id=?").run(id);
  // FEATURE: Live widgets — a deleted profile takes its tiles with it.
  db.prepare("DELETE FROM widgets WHERE page_id=?").run(id);
  db.prepare("DELETE FROM pages WHERE id=?").run(id);
}

// Fields the editor may change on a page. A whitelist rather than a passthrough:
// the id is not rewritable, `show_labels`/`hidden` have to be normalised to 0/1
// so a stray truthy value cannot end up stored as text, and `layout_config` is
// sanitized to stored JSON text (or NULL) rather than written raw.
const PAGE_FIELDS = new Set([
  "name",
  "position",
  "show_labels",
  "hidden",
  "layout_config",
]);

function updatePage(id, fields) {
  const existing = getPage(id);
  if (!existing) return null;
  const toSave = {};
  for (const key of Object.keys(fields)) {
    if (!PAGE_FIELDS.has(key)) continue;
    if (key === "show_labels" || key === "hidden")
      toSave[key] = fields[key] ? 1 : 0;
    else if (key === "layout_config")
      toSave[key] = sanitizeLayoutConfig(fields[key]);
    else toSave[key] = fields[key];
  }
  if (!Object.keys(toSave).length) return existing;

  const sql = Object.keys(toSave)
    .map((k) => `${k}=?`)
    .join(", ");
  db.prepare(`UPDATE pages SET ${sql} WHERE id=?`).run(
    ...Object.values(toSave),
    id,
  );
  return getPage(id);
}

// --- Profile auto-switch rules ---
function deserializeRule(rule) {
  return {
    ...rule,
    enabled: Number(rule.enabled) === 1,
    conditions: safeJsonArray(rule.conditions),
  };
}

function safeJsonArray(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeRule(rule) {
  const logic =
    String(rule.logic || "AND").toUpperCase() === "OR" ? "OR" : "AND";
  const priority = Number.isFinite(Number(rule.priority))
    ? Math.max(0, Math.min(1000, Number(rule.priority)))
    : 100;
  const switch_delay = Math.max(
    0,
    Math.min(5000, Number(rule.switch_delay ?? 0)),
  );
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];

  return {
    page_id: rule.page_id,
    enabled: rule.enabled ? 1 : 0,
    priority,
    logic,
    switch_delay,
    conditions: JSON.stringify(conditions),
  };
}

function getProfileRules() {
  return db
    .prepare("SELECT * FROM profile_rules ORDER BY priority DESC, rowid ASC")
    .all()
    .map(deserializeRule);
}

function getProfileRule(id) {
  const rule = db.prepare("SELECT * FROM profile_rules WHERE id=?").get(id);
  return rule ? deserializeRule(rule) : null;
}

function createProfileRule(rule) {
  const normalized = normalizeRule(rule);
  db.prepare(
    `INSERT INTO profile_rules
      (id, page_id, enabled, priority, logic, conditions, switch_delay)
     VALUES (?,?,?,?,?,?,?)`,
  ).run(
    rule.id,
    normalized.page_id,
    normalized.enabled,
    normalized.priority,
    normalized.logic,
    normalized.conditions,
    normalized.switch_delay,
  );
  return getProfileRule(rule.id);
}

function updateProfileRule(id, fields) {
  const existing = getProfileRule(id);
  if (!existing) return null;
  const normalized = normalizeRule({ ...existing, ...fields });
  db.prepare(
    `UPDATE profile_rules
     SET page_id=?, enabled=?, priority=?, logic=?, conditions=?, switch_delay=?
     WHERE id=?`,
  ).run(
    normalized.page_id,
    normalized.enabled,
    normalized.priority,
    normalized.logic,
    normalized.conditions,
    normalized.switch_delay,
    id,
  );
  return getProfileRule(id);
}

function deleteProfileRule(id) {
  db.prepare("DELETE FROM profile_rules WHERE id=?").run(id);
}

// --- Paired devices ---
// Tokens are never handed back out of here in bulk except for the auth check
// itself; listPairedDevices deliberately omits the token so the UI can show
// devices without exposing credentials.
function createPairedDevice({ id, token, name }) {
  db.prepare(
    `INSERT INTO paired_devices (id, token, name, created_at, last_seen)
     VALUES (?,?,?,?,?)`,
  ).run(id, token, name || null, new Date().toISOString(), null);
}

function getPairedDeviceTokens() {
  return db
    .prepare("SELECT token FROM paired_devices")
    .all()
    .map((r) => r.token);
}

function listPairedDevices() {
  return db
    .prepare(
      "SELECT id, name, created_at, last_seen FROM paired_devices ORDER BY created_at",
    )
    .all();
}

function getPairedDeviceIdByToken(token) {
  return (
    db.prepare("SELECT id FROM paired_devices WHERE token=?").get(token)?.id ??
    null
  );
}

function touchPairedDevice(token) {
  db.prepare("UPDATE paired_devices SET last_seen=? WHERE token=?").run(
    new Date().toISOString(),
    token,
  );
}

function deletePairedDevice(id) {
  const info = db.prepare("DELETE FROM paired_devices WHERE id=?").run(id);
  return info.changes > 0;
}

// --- Buttons ---
// FEATURE: Responsive layout — slot is the authoritative page order once a
// page has been reordered/moved through the slot writers; rows that predate it
// (or were created since) fall back to their legacy position via COALESCE.
function getButtons(page_id) {
  return db
    .prepare(
      "SELECT * FROM buttons WHERE page_id=? ORDER BY COALESCE(slot, position), rowid",
    )
    .all(page_id)
    .map(deserializeButton);
}
function getButton(id) {
  const btn = db.prepare("SELECT * FROM buttons WHERE id=?").get(id);
  return btn ? deserializeButton(btn) : null;
}
function deserializeButton(btn) {
  return {
    ...btn,
    actions: safeJsonArray(btn.actions),
    switch_actions_a: safeJsonArray(btn.switch_actions_a),
    switch_actions_b: safeJsonArray(btn.switch_actions_b),
  };
}

function createButton(btn) {
  // FEATURE: Responsive layout (task 2.2 review) — a new row is stamped with
  // slot = the page's current item count (both kinds, one SELECT), so a
  // slot-merge-sorting client appends it at the tail immediately. Falling back
  // to per-kind `position` via COALESCE would interleave it mid-deck on pages
  // whose slots were already densified. The value is derived here, never taken
  // from the caller, so slot stays out of every client-facing whitelist.
  db.prepare(
    `
    INSERT INTO buttons (
      id, page_id, label, icon, icon_data, color, position,
      action_type, action_value, size,
      is_toggle, toggle_state, toggle_action_type, toggle_action_value,
      actions, button_mode, switch_actions_a, switch_actions_b, switch_state,
      sound_file, sound_target, audio_device, slot
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,
  ).run(
    btn.id,
    btn.page_id,
    btn.label,
    btn.icon,
    btn.icon_data || null,
    btn.color,
    btn.position,
    btn.action_type,
    btn.action_value,
    btn.size || "1x1",
    btn.is_toggle ? 1 : 0,
    btn.toggle_state ? 1 : 0,
    btn.toggle_action_type || "keystroke",
    btn.toggle_action_value || "",
    btn.actions ? JSON.stringify(btn.actions) : null,
    btn.button_mode || "single",
    btn.switch_actions_a ? JSON.stringify(btn.switch_actions_a) : null,
    btn.switch_actions_b ? JSON.stringify(btn.switch_actions_b) : null,
    btn.switch_state ? 1 : 0,
    btn.sound_file || null,
    btn.sound_target || "phone",
    btn.audio_device || null,
    nextItemSlot(btn.page_id),
  );
  return getButton(btn.id);
}

function updateButton(id, fields) {
  const allowed = [
    "label",
    "icon",
    "icon_data",
    "color",
    "position",
    "action_type",
    "action_value",
    "size",
    "is_toggle",
    "toggle_state",
    "toggle_action_type",
    "toggle_action_value",
    "actions",
    "button_mode",
    "switch_actions_a",
    "switch_actions_b",
    "switch_state",
    "sound_file",
    "sound_target",
    "audio_device",
    "require_confirm",
  ];
  const toSave = { ...fields };
  if (toSave.actions !== undefined)
    toSave.actions = toSave.actions ? JSON.stringify(toSave.actions) : null;
  if (toSave.switch_actions_a !== undefined)
    toSave.switch_actions_a = toSave.switch_actions_a
      ? JSON.stringify(toSave.switch_actions_a)
      : null;
  if (toSave.switch_actions_b !== undefined)
    toSave.switch_actions_b = toSave.switch_actions_b
      ? JSON.stringify(toSave.switch_actions_b)
      : null;

  const keys = Object.keys(toSave).filter((k) => allowed.includes(k));
  if (!keys.length) return getButton(id);

  const sql = keys.map((k) => `${k}=?`).join(", ");
  db.prepare(`UPDATE buttons SET ${sql} WHERE id=?`).run(
    ...keys.map((k) => toSave[k]),
    id,
  );
  return getButton(id);
}

function deleteButton(id) {
  db.prepare("DELETE FROM buttons WHERE id=?").run(id);
}

function reorderButtons(buttons) {
  const update = db.prepare(`UPDATE buttons SET position=? WHERE id=?`);
  db.transaction((items) => {
    for (const item of items) update.run(item.position, item.id);
  })(buttons);
}

// --- Slot writers (responsive layout, plan D2) ---
// The only sanctioned writers of `slot` (and of a widget's `page_id` for
// moves). Both validate through itemOrder.applyReorder before writing, so a
// rejected batch is all-or-nothing: a half-slotted page cannot be produced.

/** Raw per-kind rows for a page — the shape itemOrder's validators read. */
function getItemRows(page_id) {
  return {
    buttons: db
      .prepare(
        "SELECT id, slot, position, rowid FROM buttons WHERE page_id=? ORDER BY COALESCE(slot, position), rowid",
      )
      .all(page_id),
    widgets: db
      .prepare(
        "SELECT id, slot, position, rowid FROM widgets WHERE page_id=? ORDER BY COALESCE(slot, position), rowid",
      )
      .all(page_id),
  };
}

/**
 * Next append slot for a page: total item count across both kinds, in a
 * single SELECT. Used by the create paths (task 2.2 review) so new rows join
 * an already-densified slot sequence at the tail instead of relying on
 * COALESCE(slot, position), whose per-kind position would interleave them
 * mid-deck for slot-merge-sorting clients.
 */
function nextItemSlot(page_id) {
  // Two aliased columns read off the row object — better-sqlite3 hands back an
  // object here, not a bare number, and binding that object would be read as
  // named parameters (RangeError: too few values).
  const row = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM buttons WHERE page_id=?) AS b,
              (SELECT COUNT(*) FROM widgets  WHERE page_id=?) AS w`,
    )
    .get(page_id, page_id);
  return row.b + row.w;
}

/**
 * Validate a whole-page submitted list ([{kind,id,slot}]) and write both slot
 * and the derived dense position, in one transaction. Returns {ok} or {error}.
 */
function applyItemReorder(page_id, submitted) {
  const rows = getItemRows(page_id);
  const result = applyReorder(rows, submitted);
  if (result.error) return { error: result.error };
  const write = db.transaction(() => {
    for (const table of ["buttons", "widgets"]) {
      const update = db.prepare(
        `UPDATE ${table} SET slot=?, position=? WHERE id=?`,
      );
      for (const row of rows[table])
        update.run(result.slots.get(row.id), result.positions.get(row.id), row.id);
    }
  });
  write();
  return { ok: true };
}

/**
 * The sanctioned page-order writer (final polish). `submittedIds` is the full
 * VISIBLE id list in the wanted order; applyPageOrder pins hidden pages after it
 * so Unfiled can never become pages[0]. One transaction writing only
 * `pages.position` — ids, names, show_labels, hidden and layout_config are never
 * touched, and item slots/page_id are untouched by definition (the item writers
 * above stay the only ones). Returns {ok} or {error} with nothing written: the
 * transaction is guarded like moveItemToPage, so a SQLITE_BUSY/disk-level throw
 * becomes a rejection instead of an unhandled rejection in the ws handler.
 */
function applyPageReorder(submittedIds) {
  const rows = getPages();
  const result = applyPageOrder(rows, submittedIds);
  if (result.error) return { error: result.error };
  const update = db.prepare(`UPDATE pages SET position=? WHERE id=?`);
  const run = db.transaction(() => {
    for (const [id, position] of result.positions) update.run(position, id);
  });
  try {
    run();
  } catch (e) {
    return { error: e.message };
  }
  return { ok: true };
}

/**
 * The sanctioned cross-page move (plan D3): re-parents the row first — target
 * validation checks ids against the target page — then applies both pages'
 * submitted lists through applyItemReorder inside one transaction, so any
 * failure rolls the move back entirely. A same-page move skips the re-parent
 * and applies only `target` (which covers every item on the page).
 */
function moveItemToPage({ kind, id, sourcePageId, targetPageId, source, target }) {
  if (!["buttons", "widgets"].includes(kind))
    return { error: `unknown kind "${kind}"` };
  const samePage = sourcePageId === targetPageId;
  const run = db.transaction(() => {
    if (!samePage) {
      db.prepare(`UPDATE ${kind} SET page_id=? WHERE id=?`).run(targetPageId, id);
      const moved = applyItemReorder(sourcePageId, source);
      if (moved.error) throw new Error(moved.error);
    }
    const landed = applyItemReorder(targetPageId, target);
    if (landed.error) throw new Error(landed.error);
  });
  try {
    run();
  } catch (e) {
    return { error: e.message };
  }
  return { ok: true };
}

// --- Layout presets (plan D7) ---
// Rows hold the preset as stored JSON text; sanitization happens on the way
// in (layoutConfig.sanitizePresetConfig) exactly like layout_config itself.
function getLayoutPresets() {
  return db
    .prepare("SELECT * FROM layout_presets ORDER BY created_at, rowid")
    .all();
}

function createLayoutPreset({ id, name, config }) {
  db.prepare(
    `INSERT INTO layout_presets (id, name, config, created_at) VALUES (?,?,?,?)`,
  ).run(id, name, config, new Date().toISOString());
  return db.prepare("SELECT * FROM layout_presets WHERE id=?").get(id);
}

function getLayoutPreset(id) {
  return db.prepare("SELECT * FROM layout_presets WHERE id=?").get(id) || null;
}

function deleteLayoutPreset(id) {
  const info = db.prepare("DELETE FROM layout_presets WHERE id=?").run(id);
  return info.changes > 0;
}

// --- Live widgets ---
// FEATURE: Live widgets — a tile that receives data rather than an action.
// Deliberately shaped like a button (page_id, position, size, label, icon,
// color) so the editor can treat them alike, minus everything action-shaped.

function getWidgets(page_id) {
  return db
    .prepare(
      "SELECT * FROM widgets WHERE page_id=? ORDER BY COALESCE(slot, position), rowid ASC",
    )
    .all(page_id)
    .map(deserializeWidget);
}

function getAllWidgets() {
  return db
    .prepare("SELECT * FROM widgets ORDER BY position, rowid ASC")
    .all()
    .map(deserializeWidget);
}

function getWidget(id) {
  const row = db.prepare("SELECT * FROM widgets WHERE id=?").get(id);
  return row ? deserializeWidget(row) : null;
}

function createWidget(widget) {
  const defaults = widgetDefaults();
  // Slot stamping mirrors createButton (task 2.2 review): the page-count slot
  // keeps a fresh widget at the tail of the interleaved order instead of
  // COALESCE-ing its per-kind position into the middle of the deck. position
  // keeps its legacy per-kind value — old clients must not see a change.
  db.prepare(
    `INSERT INTO widgets
       (id, page_id, type, position, size, label, icon, color, source_id, config, slot)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    widget.id,
    widget.page_id,
    widget.type || defaults.type,
    widget.position ?? 0,
    widget.size || defaults.size,
    widget.label ?? defaults.label,
    widget.icon ?? defaults.icon,
    widget.color ?? defaults.color,
    widget.source_id ?? null,
    typeof widget.config === "string"
      ? widget.config
      : JSON.stringify(widget.config ?? defaults.config),
    nextItemSlot(widget.page_id),
  );
  return getWidget(widget.id);
}

function updateWidget(id, fields) {
  const existing = getWidget(id);
  if (!existing) return null;
  const { values, keys } = buildWidgetUpdate(fields);
  if (!keys) return existing;
  const sql = keys.map((k) => `${k}=?`).join(", ");
  db.prepare(`UPDATE widgets SET ${sql} WHERE id=?`).run(
    ...keys.map((k) => values[k]),
    id,
  );
  return getWidget(id);
}

function deleteWidget(id) {
  db.prepare("DELETE FROM widgets WHERE id=?").run(id);
}

function reorderWidgets(widgets) {
  const update = db.prepare("UPDATE widgets SET position=? WHERE id=?");
  db.transaction((items) => {
    for (const item of items) update.run(item.position, item.id);
  })(widgets);
}

// --- Live widget data sources ---
// FEATURE: Live widgets — a configured place metrics come from. The current
// host is one source of them; the abstraction exists so a NAS or a VPS is a
// new row rather than new code.

function getSources() {
  return db.prepare("SELECT * FROM widget_sources ORDER BY created_at").all();
}

function getSource(id) {
  const row = db.prepare("SELECT * FROM widget_sources WHERE id=?").get(id);
  return row || null;
}

/** Raw row, secret blob included. Internal only — never crosses the API. */
function getSourceWithSecret(id) {
  return getSource(id);
}

function createSource(source) {
  const defaults = sourceDefaults();
  const row = {
    id: source.id,
    kind: "ssh",
    name: source.name || defaults.name,
    host: source.host || "",
    port: source.port ?? defaults.port,
    username: source.username || "",
    key_path: source.key_path || "",
    auth: source.auth ?? null,
    use_agent: source.use_agent ? 1 : 0,
    refresh_ms: source.refresh_ms ?? defaults.refresh_ms,
    enabled: source.enabled === false ? 0 : 1,
    created_at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO widget_sources
       (id, kind, name, host, port, username, key_path, auth, use_agent,
        refresh_ms, enabled, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    row.id,
    row.kind,
    row.name,
    row.host,
    row.port,
    row.username,
    row.key_path,
    row.auth,
    row.use_agent,
    row.refresh_ms,
    row.enabled,
    row.created_at,
  );
  return getSource(row.id);
}

function updateSource(id, fields) {
  const existing = getSource(id);
  if (!existing) return null;
  const { values, keys } = buildSourceUpdate(fields);
  if (!keys) return existing;
  const sql = keys.map((k) => `${k}=?`).join(", ");
  db.prepare(`UPDATE widget_sources SET ${sql} WHERE id=?`).run(
    ...keys.map((k) => values[k]),
    id,
  );
  return getSource(id);
}

function deleteSource(id) {
  db.prepare("DELETE FROM widget_sources WHERE id=?").run(id);
  // Widgets that pointed at it stay, but repoint at the local machine rather
  // than dangling: a tile that silently stops updating is a worse outcome than
  // one that shows the host it is running on.
  db.prepare("UPDATE widgets SET source_id=NULL WHERE source_id=?").run(id);
}

module.exports = {
  // Re-exported so the PATCH route and the tests read the same whitelist the
  // rest of the layout primitives live in (a single source of truth; the
  // function itself is pure and lives in layoutConfig.js).
  BUTTON_SIZES,
  getPages,
  createPage,
  getPage,
  updatePage,
  deletePage,
  createPairedDevice,
  getPairedDeviceTokens,
  getPairedDeviceIdByToken,
  listPairedDevices,
  touchPairedDevice,
  deletePairedDevice,
  getButtons,
  getButton,
  createButton,
  updateButton,
  deleteButton,
  reorderButtons,
  getItemRows,
  applyItemReorder,
  moveItemToPage,
  applyPageReorder,
  getLayoutPresets,
  createLayoutPreset,
  getLayoutPreset,
  deleteLayoutPreset,
  getWidgets,
  getAllWidgets,
  getWidget,
  createWidget,
  updateWidget,
  deleteWidget,
  reorderWidgets,
  getSources,
  getSource,
  getSourceWithSecret,
  createSource,
  updateSource,
  deleteSource,
  getSetting,
  setSetting,
  getProfileRules,
  getProfileRule,
  createProfileRule,
  updateProfileRule,
  deleteProfileRule,
};

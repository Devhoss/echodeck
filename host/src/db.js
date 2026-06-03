const Database = require("better-sqlite3");
const path = require("path");
const os = require("os");
const fs = require("fs");

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
    position INTEGER DEFAULT 0
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
    sound_file TEXT DEFAULT NULL,
    -- FEATURE: Soundboard routing — 'phone' | 'pc' | 'both'
    sound_target TEXT DEFAULT 'phone',
    audio_device TEXT DEFAULT NULL,
    FOREIGN KEY (page_id) REFERENCES pages(id)
  );

  -- FEATURE: Settings — global key/value store (PC output device name lives here)
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS profile_rules (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    priority INTEGER DEFAULT 100,
    logic TEXT DEFAULT 'AND',
    conditions TEXT NOT NULL DEFAULT '[]',
    FOREIGN KEY (page_id) REFERENCES pages(id)
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
if (!existingCols.includes("sound_file"))
  db.exec(`ALTER TABLE buttons ADD COLUMN sound_file TEXT DEFAULT NULL`);
if (!existingCols.includes("sound_target"))
  db.exec(`ALTER TABLE buttons ADD COLUMN sound_target TEXT DEFAULT 'phone'`);
if (!existingCols.includes("audio_device"))
  db.exec(`ALTER TABLE buttons ADD COLUMN audio_device TEXT DEFAULT NULL`);

// --- Seed ---
const pageCount = db.prepare("SELECT COUNT(*) as c FROM pages").get().c;
if (pageCount === 0) {
  db.prepare(`INSERT INTO pages VALUES ('page_main', 'Main', 0)`).run();

  const insertBtn = db.prepare(`
    INSERT INTO buttons (
      id, page_id, label, icon, icon_data, color, position,
      action_type, action_value, size,
      is_toggle, toggle_state, toggle_action_type, toggle_action_value,
      actions, sound_file, sound_target, audio_device
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
  return db.prepare("SELECT * FROM pages ORDER BY position").all();
}
function createPage(id, name, position) {
  db.prepare(`INSERT INTO pages VALUES (?,?,?)`).run(id, name, position);
  return getPage(id);
}
function getPage(id) {
  return db.prepare("SELECT * FROM pages WHERE id=?").get(id);
}
function deletePage(id) {
  db.prepare("DELETE FROM buttons WHERE page_id=?").run(id);
  db.prepare("DELETE FROM profile_rules WHERE page_id=?").run(id);
  db.prepare("DELETE FROM pages WHERE id=?").run(id);
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
  const logic = String(rule.logic || "AND").toUpperCase() === "OR" ? "OR" : "AND";
  const priority = Number.isFinite(Number(rule.priority))
    ? Math.max(0, Math.min(1000, Number(rule.priority)))
    : 100;
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];

  return {
    page_id: rule.page_id,
    enabled: rule.enabled ? 1 : 0,
    priority,
    logic,
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
      (id, page_id, enabled, priority, logic, conditions)
     VALUES (?,?,?,?,?,?)`,
  ).run(
    rule.id,
    normalized.page_id,
    normalized.enabled,
    normalized.priority,
    normalized.logic,
    normalized.conditions,
  );
  return getProfileRule(rule.id);
}

function updateProfileRule(id, fields) {
  const existing = getProfileRule(id);
  if (!existing) return null;
  const normalized = normalizeRule({ ...existing, ...fields });
  db.prepare(
    `UPDATE profile_rules
     SET page_id=?, enabled=?, priority=?, logic=?, conditions=?
     WHERE id=?`,
  ).run(
    normalized.page_id,
    normalized.enabled,
    normalized.priority,
    normalized.logic,
    normalized.conditions,
    id,
  );
  return getProfileRule(id);
}

function deleteProfileRule(id) {
  db.prepare("DELETE FROM profile_rules WHERE id=?").run(id);
}

// --- Buttons ---
function getButtons(page_id) {
  return db
    .prepare("SELECT * FROM buttons WHERE page_id=? ORDER BY position")
    .all(page_id)
    .map(deserializeButton);
}
function getButton(id) {
  const btn = db.prepare("SELECT * FROM buttons WHERE id=?").get(id);
  return btn ? deserializeButton(btn) : null;
}
function deserializeButton(btn) {
  return { ...btn, actions: btn.actions ? JSON.parse(btn.actions) : null };
}

function createButton(btn) {
  db.prepare(
    `
    INSERT INTO buttons (
      id, page_id, label, icon, icon_data, color, position,
      action_type, action_value, size,
      is_toggle, toggle_state, toggle_action_type, toggle_action_value,
      actions, sound_file, sound_target, audio_device
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
    btn.sound_file || null,
    btn.sound_target || "phone",
    btn.audio_device || null,
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
    "sound_file",
    "sound_target",
    "audio_device",
  ];
  const toSave = { ...fields };
  if (toSave.actions !== undefined)
    toSave.actions = toSave.actions ? JSON.stringify(toSave.actions) : null;

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

module.exports = {
  getPages,
  createPage,
  getPage,
  deletePage,
  getButtons,
  getButton,
  createButton,
  updateButton,
  deleteButton,
  reorderButtons,
  getSetting,
  setSetting,
  getProfileRules,
  getProfileRule,
  createProfileRule,
  updateProfileRule,
  deleteProfileRule,
};

// seed.js — Sandbox seeding: settings.json + chat_history.db fixtures.
// Schema mirrors chat/db/ChatDB.ahk _CreateSchema() exactly.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function uuid() {
  return crypto.randomUUID();
}

// Build default providers pointing at the mock endpoint (and closed-port endpoint
// for the connection-refused scenario).
function defaultProviders(endpoint, fimEndpoint = '') {
  return {
    deepseek: {
      displayName: 'DeepSeek', endpoint, fimEndpoint,
      authMode: 'env', authEnvVar: 'DEEPSEEK_API_KEY', apiKey: '',
      icon: '', collapseThinking: false, prefixes: ['deepseek']
    },
    openai: {
      displayName: 'OpenAI', endpoint, fimEndpoint: '',
      authMode: 'env', authEnvVar: 'OPENAI_API_KEY', apiKey: '',
      icon: '', collapseThinking: false, prefixes: ['gpt', 'openai']
    },
    google: {
      displayName: 'Google Gemini', endpoint, fimEndpoint: '',
      authMode: 'env', authEnvVar: 'GOOGLE_API_KEY', apiKey: '',
      icon: '', collapseThinking: false, prefixes: ['gemini', 'gemma', 'google']
    },
    openrouter: {
      displayName: 'OpenRouter', endpoint, fimEndpoint: '',
      authMode: 'env', authEnvVar: 'OPENROUTER_API_KEY', apiKey: '',
      icon: '', collapseThinking: false, prefixes: ['openrouter']
    }
  };
}

// Write settings.json for a scenario directly into the app's data dir.
// `overrides` keys are merged over a base containing providers (mock endpoint)
// + threadTitles + trash + menuItems.
function writeSettings(dir, overrides, endpoint) {
  ensureDir(dir);
  const base = {
    providers: defaultProviders(endpoint),
    threadTitles: { enabled: true, model: 'deepseek/deepseek-v4-flash', prompt: 'Generate a short title.', maxTokens: 50 },
    // Headless runs never inject hotkeys, and disabling the defaults prevents
    // parallel workers from reacting to the user's real keyboard input.
    hotkeys: { main: '', reload: '', closeWindows: '', suspend: '' },
    trash: { retentionDays: 30 },
    menuItems: { quickAccess: [{ menuText: '&7 - Usage Dashboard', command: 'usage:' }], tray: [] }
  };
  const settings = Object.assign({}, base, overrides || {});
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2), 'utf-8');
  ensureDir(path.join(dir, 'system-messages'));
  return path.join(dir, 'settings.json');
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS chat_folders (id TEXT PRIMARY KEY, name TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chat_threads (id TEXT PRIMARY KEY, title TEXT DEFAULT 'New Chat', is_deleted INTEGER DEFAULT 0, deleted_at TEXT, created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')), active_leaf_id TEXT, cumulative_input_tokens INTEGER DEFAULT 0, cumulative_output_tokens INTEGER DEFAULT 0, cumulative_cached_tokens INTEGER DEFAULT 0, cumulative_cost REAL DEFAULT 0, cumulative_input_cost REAL DEFAULT 0, cumulative_cached_input_cost REAL DEFAULT 0, cumulative_output_cost REAL DEFAULT 0, assistant_id TEXT, model_override TEXT, system_override TEXT, reasoning_override TEXT, temperature_override REAL, system_override_set INTEGER DEFAULT 0, reasoning_override_set INTEGER DEFAULT 0, temperature_override_set INTEGER DEFAULT 0, font_size INTEGER DEFAULT 17, folder_id TEXT, is_locked INTEGER DEFAULT 0, advanced_toggles TEXT DEFAULT '', FOREIGN KEY (folder_id) REFERENCES chat_folders(id) ON DELETE SET NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, provider TEXT DEFAULT '', parent_id TEXT, sibling_group TEXT, sibling_index INTEGER DEFAULT 0, reasoning TEXT DEFAULT '', token_count INTEGER DEFAULT 0, prompt_tokens INTEGER DEFAULT 0, thinking_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0, response_time_ms INTEGER DEFAULT 0, ttft_ms INTEGER DEFAULT 0, active_path_tokens INTEGER DEFAULT 0, is_local_copy INTEGER DEFAULT 0, api_output_tokens INTEGER DEFAULT 0, input_cost REAL DEFAULT 0, cached_input_cost REAL DEFAULT 0, output_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS chat_locks (thread_id TEXT PRIMARY KEY REFERENCES chat_threads(id) ON DELETE CASCADE, kdf TEXT NOT NULL DEFAULT 'pbkdf2-sha256', salt TEXT NOT NULL, hash TEXT NOT NULL, iterations INTEGER NOT NULL DEFAULT 600000)`,
  `CREATE TABLE IF NOT EXISTS message_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, attachment_type TEXT NOT NULL, file_path TEXT NOT NULL, mime_type TEXT, original_filename TEXT, file_size INTEGER DEFAULT 0, extracted_text TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')), FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE)`,
  `CREATE TABLE IF NOT EXISTS command_usage (date TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, command_name TEXT NOT NULL, call_count INTEGER DEFAULT 1, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, thinking_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0, input_cost REAL DEFAULT 0, cached_input_cost REAL DEFAULT 0, output_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, total_response_time_ms INTEGER DEFAULT 0, total_ttft_ms INTEGER DEFAULT 0, ttft_count INTEGER DEFAULT 0, PRIMARY KEY (date, model, provider, command_name))`,
  `CREATE TABLE IF NOT EXISTS chat_usage (date TEXT NOT NULL, model TEXT NOT NULL, provider TEXT NOT NULL, call_count INTEGER DEFAULT 1, prompt_tokens INTEGER DEFAULT 0, completion_tokens INTEGER DEFAULT 0, thinking_tokens INTEGER DEFAULT 0, cached_tokens INTEGER DEFAULT 0, input_cost REAL DEFAULT 0, cached_input_cost REAL DEFAULT 0, output_cost REAL DEFAULT 0, total_cost REAL DEFAULT 0, total_response_time_ms INTEGER DEFAULT 0, total_ttft_ms INTEGER DEFAULT 0, ttft_count INTEGER DEFAULT 0, PRIMARY KEY (date, model, provider))`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_message ON message_attachments(message_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_sibling ON messages(sibling_group, sibling_index)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(msg_id, content)`
];

function createDb(dir, fixtures = {}) {
  ensureDir(dir);
  const dbPath = path.join(dir, 'chat_history.db');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA auto_vacuum=INCREMENTAL');
  db.exec('PRAGMA foreign_keys=ON');
  for (const ddl of SCHEMA) db.exec(ddl);

  for (const f of fixtures.folders || []) {
    db.prepare('INSERT INTO chat_folders (id, name) VALUES (?, ?)').run(f.id, f.name);
  }
  for (const t of fixtures.threads || []) {
    db.prepare(
      `INSERT INTO chat_threads (id, title, is_deleted, deleted_at, active_leaf_id, assistant_id, model_override, system_override, reasoning_override, temperature_override, system_override_set, reasoning_override_set, temperature_override_set, font_size, folder_id, is_locked, cumulative_input_tokens, cumulative_output_tokens, cumulative_cached_tokens, cumulative_cost, cumulative_input_cost, cumulative_cached_input_cost, cumulative_output_cost, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), COALESCE(?, datetime('now')))`
    ).run(
      t.id, t.title || 'New Chat', t.is_deleted ? 1 : 0, t.deleted_at || null,
      t.active_leaf_id || null, t.assistant_id || null, t.model_override || null,
      t.system_override || null, t.reasoning_override || null,
      t.temperature_override != null ? t.temperature_override : null,
      t.system_override_set != null ? (t.system_override_set ? 1 : 0) : (t.system_override ? 1 : 0),
      t.reasoning_override_set != null ? (t.reasoning_override_set ? 1 : 0) : (t.reasoning_override ? 1 : 0),
      t.temperature_override_set != null ? (t.temperature_override_set ? 1 : 0) : (t.temperature_override != null ? 1 : 0),
      t.font_size != null ? t.font_size : 17, t.folder_id || null, t.is_locked ? 1 : 0,
      t.cumulative_input_tokens || 0, t.cumulative_output_tokens || 0,
      t.cumulative_cached_tokens || 0, t.cumulative_cost || 0,
      t.cumulative_input_cost || 0, t.cumulative_cached_input_cost || 0,
      t.cumulative_output_cost || 0,
      t.created_at || null, t.created_at || null
    );
  }
  for (const l of fixtures.chatLocks || []) {
    db.prepare(
      `INSERT OR REPLACE INTO chat_locks (thread_id, kdf, salt, hash, iterations) VALUES (?, ?, ?, ?, ?)`
    ).run(l.thread_id, l.kdf || 'pbkdf2-sha256', l.salt, l.hash, l.iterations || 600000);
  }
  for (const m of fixtures.messages || []) {
    db.prepare(
      `INSERT INTO messages (id, thread_id, role, content, model, parent_id, sibling_group, sibling_index, reasoning, token_count, prompt_tokens, thinking_tokens, cached_tokens, response_time_ms, ttft_ms, active_path_tokens, is_local_copy, api_output_tokens, input_cost, cached_input_cost, output_cost, total_cost, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    ).run(
      m.id, m.thread_id, m.role, m.content, m.model || null, m.parent_id || null,
      m.sibling_group || null, m.sibling_index || 0, m.reasoning || '', m.token_count || 0,
      m.prompt_tokens || 0, m.thinking_tokens || 0, m.cached_tokens || 0, m.response_time_ms || 0, m.ttft_ms || 0,
      m.active_path_tokens || 0, m.is_local_copy ? 1 : 0,
      m.api_output_tokens != null ? m.api_output_tokens : (m.role === 'assistant' && !m.is_local_copy ? (m.token_count || 0) : 0),
      m.input_cost || 0, m.cached_input_cost || 0, m.output_cost || 0, m.total_cost || 0,
      m.created_at || null
    );
  }
  for (const u of fixtures.chatUsage || []) {
    db.prepare(
      `INSERT OR REPLACE INTO chat_usage (date, model, provider, call_count, prompt_tokens, completion_tokens, thinking_tokens, cached_tokens, input_cost, cached_input_cost, output_cost, total_cost, total_response_time_ms, total_ttft_ms, ttft_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      u.date, u.model, u.provider, u.call_count || 1, u.prompt_tokens || 0, u.completion_tokens || 0,
      u.thinking_tokens || 0, u.cached_tokens || 0, u.input_cost || 0, u.cached_input_cost || 0,
      u.output_cost || 0, u.total_cost || 0, u.total_response_time_ms || 0, u.total_ttft_ms || 0,
      u.ttft_count != null ? u.ttft_count : (u.total_ttft_ms > 0 ? 1 : 0)
    );
  }
  db.close();
  return dbPath;
}

function query(dbPath, sql, params = []) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const stmt = db.prepare(sql);
    return stmt.all(...params);
  } finally {
    db.close();
  }
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  // Usage dates are local-calendar keys. Converting through toISOString()
  // shifts midnight-adjacent fixtures backward in UTC+x zones.
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return d.getFullYear() + '-' + month + '-' + day;
}

module.exports = { writeSettings, createDb, query, uuid, daysAgo };

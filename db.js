import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

const DB_PATH = process.env.DB_PATH || './data.db';

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    panel_json TEXT NOT NULL,
    aggregator TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS panel_runs (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    drafts_json TEXT NOT NULL,
    revisions_json TEXT NOT NULL,
    synthesis_text TEXT,
    synthesis_model TEXT,
    error TEXT,
    ms_total INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_panel_runs_message ON panel_runs(message_id);
`);

// Migrations idempotentes (ADD COLUMN não tem IF NOT EXISTS em sqlite antigo).
function safeAddColumn(table, column, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}
safeAddColumn('conversations', 'summary', 'TEXT');
safeAddColumn('conversations', 'summary_message_count', 'INTEGER DEFAULT 0');
safeAddColumn('panel_runs', 'mode', 'TEXT');

const stmts = {
  insertConversation: db.prepare(`
    INSERT INTO conversations (id, title, panel_json, aggregator, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  touchConversation: db.prepare(`
    UPDATE conversations SET updated_at = ?, title = COALESCE(?, title) WHERE id = ?
  `),
  updateSummary: db.prepare(`
    UPDATE conversations SET summary = ?, summary_message_count = ? WHERE id = ?
  `),
  getConversation: db.prepare(`SELECT * FROM conversations WHERE id = ?`),
  listConversations: db.prepare(`
    SELECT id, title, panel_json, aggregator, created_at, updated_at
    FROM conversations
    ORDER BY updated_at DESC
    LIMIT 200
  `),
  deleteConversation: db.prepare(`DELETE FROM conversations WHERE id = ?`),
  insertMessage: db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  listMessages: db.prepare(`
    SELECT id, role, content, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
  `),
  countMessages: db.prepare(`
    SELECT COUNT(*) as n FROM messages WHERE conversation_id = ?
  `),
  listRecentMessages: db.prepare(`
    SELECT id, role, content, created_at FROM (
      SELECT id, role, content, created_at
      FROM messages
      WHERE conversation_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    ) ORDER BY created_at ASC, id ASC
  `),
  listOlderMessages: db.prepare(`
    SELECT id, role, content, created_at
    FROM messages
    WHERE conversation_id = ?
    ORDER BY created_at ASC, id ASC
    LIMIT ?
  `),
  insertPanelRun: db.prepare(`
    INSERT INTO panel_runs (id, message_id, drafts_json, revisions_json, synthesis_text, synthesis_model, error, ms_total, created_at, mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  getPanelRunByMessage: db.prepare(`SELECT * FROM panel_runs WHERE message_id = ?`),
};

export function createConversation({ title, panel, aggregator }) {
  const id = randomUUID();
  const now = Date.now();
  stmts.insertConversation.run(id, title, JSON.stringify(panel), aggregator, now, now);
  return { id, title, panel, aggregator, created_at: now, updated_at: now };
}

export function touchConversation(id, newTitle = null) {
  stmts.touchConversation.run(Date.now(), newTitle, id);
}

export function getConversation(id) {
  const row = stmts.getConversation.get(id);
  if (!row) return null;
  return { ...row, panel: JSON.parse(row.panel_json) };
}

export function updateConversationSummary(id, summary, messageCount) {
  stmts.updateSummary.run(summary ?? null, messageCount ?? 0, id);
}

export function countMessages(conversationId) {
  return stmts.countMessages.get(conversationId).n;
}

export function listRecentMessages(conversationId, limit) {
  return stmts.listRecentMessages.all(conversationId, limit);
}

export function listOlderMessages(conversationId, limit) {
  return stmts.listOlderMessages.all(conversationId, limit);
}

export function listConversations() {
  return stmts.listConversations.all().map((r) => ({
    id: r.id,
    title: r.title,
    panel: JSON.parse(r.panel_json),
    aggregator: r.aggregator,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }));
}

export function deleteConversation(id) {
  stmts.deleteConversation.run(id);
}

export function addMessage(conversationId, role, content) {
  const id = randomUUID();
  const now = Date.now();
  stmts.insertMessage.run(id, conversationId, role, content, now);
  return { id, conversationId, role, content, created_at: now };
}

export function listMessages(conversationId) {
  return stmts.listMessages.all(conversationId);
}

export function savePanelRun(messageId, { drafts, revisions, synthesis_text, synthesis_model, error, ms_total, mode }) {
  const id = randomUUID();
  stmts.insertPanelRun.run(
    id,
    messageId,
    JSON.stringify(drafts),
    JSON.stringify(revisions),
    synthesis_text ?? null,
    synthesis_model ?? null,
    error ?? null,
    ms_total,
    Date.now(),
    mode ?? null
  );
  return id;
}

export function getPanelRunByMessage(messageId) {
  const row = stmts.getPanelRunByMessage.get(messageId);
  if (!row) return null;
  return {
    id: row.id,
    drafts: JSON.parse(row.drafts_json),
    revisions: JSON.parse(row.revisions_json),
    synthesis_text: row.synthesis_text,
    synthesis_model: row.synthesis_model,
    error: row.error,
    ms_total: row.ms_total,
    created_at: row.created_at,
    mode: row.mode ?? null,
  };
}

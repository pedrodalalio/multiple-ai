import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { DB_PATH, CONVERSATION_PAGE_SIZE, MESSAGE_PAGE_SIZE } from './config.js';

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
  CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
`);

// Migrations idempotentes (ADD COLUMN não tem IF NOT EXISTS em sqlite antigo).
function safeAddColumn(table, column, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    return true;
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
    return false;
  }
}

safeAddColumn('conversations', 'summary', 'TEXT');
safeAddColumn('conversations', 'summary_message_count', 'INTEGER DEFAULT 0');
safeAddColumn('panel_runs', 'mode', 'TEXT');

// `is_error` marca turnos que falharam/foram cancelados. Eles continuam visíveis
// no histórico da UI, mas ficam FORA do contexto mandado pros modelos — senão a
// string "[erro] rate limit" vira input de todas as chamadas seguintes.
if (safeAddColumn('messages', 'is_error', 'INTEGER NOT NULL DEFAULT 0')) {
  db.prepare(
    `UPDATE messages SET is_error = 1
     WHERE role = 'assistant'
       AND (content LIKE '[erro]%' OR content LIKE '[síntese falhou]%' OR content LIKE '[cancelado]%')`
  ).run();
}
// Índices pensados pra ordenação por rowid: no sqlite, toda entrada de índice
// termina implicitamente no rowid, então (conversation_id) já serve pra varrer
// uma conversa em ordem de inserção.
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_messages_hist_seq ON messages(conversation_id, is_error);
`);

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
    LIMIT ? OFFSET ?
  `),
  deleteConversation: db.prepare(`DELETE FROM conversations WHERE id = ?`),

  insertMessage: db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, created_at, is_error)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  // Detalhe da conversa: um único JOIN em vez de N+1 (uma query por mensagem).
  // Ordena por rowid, nunca por (created_at, id): duas mensagens gravadas no
  // mesmo milissegundo ficariam em ordem aleatória, já que o id é um UUID v4.
  listMessagesPage: db.prepare(`
    SELECT * FROM (
      SELECT
        m.rowid AS seq, m.id, m.role, m.content, m.created_at, m.is_error,
        p.id AS panel_id, p.drafts_json, p.revisions_json, p.synthesis_text,
        p.synthesis_model, p.error AS panel_error, p.ms_total, p.mode,
        p.created_at AS panel_created_at
      FROM messages m
      LEFT JOIN panel_runs p ON p.message_id = m.id
      WHERE m.conversation_id = ? AND m.rowid < ?
      ORDER BY m.rowid DESC
      LIMIT ?
    ) ORDER BY seq ASC
  `),
  countMessages: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ?`),
  countMessagesBefore: db.prepare(`
    SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND rowid < ?
  `),

  // Contexto mandado pros modelos: só turnos bem-sucedidos.
  countHistoryMessages: db.prepare(`
    SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND is_error = 0
  `),
  listRecentHistory: db.prepare(`
    SELECT id, role, content, created_at FROM (
      SELECT rowid AS seq, id, role, content, created_at
      FROM messages
      WHERE conversation_id = ? AND is_error = 0
      ORDER BY rowid DESC
      LIMIT ?
    ) ORDER BY seq ASC
  `),
  listOlderHistory: db.prepare(`
    SELECT id, role, content, created_at
    FROM messages
    WHERE conversation_id = ? AND is_error = 0
    ORDER BY rowid ASC
    LIMIT ?
  `),

  insertPanelRun: db.prepare(`
    INSERT INTO panel_runs (
      id, message_id, drafts_json, revisions_json, synthesis_text,
      synthesis_model, error, ms_total, created_at, mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
};

// ---------- conversations ----------

export function createConversation({ title, panel, aggregator }) {
  const id = randomUUID();
  const now = Date.now();
  stmts.insertConversation.run(id, title, JSON.stringify(panel), aggregator, now, now);
  return { id, title, panel, aggregator, created_at: now, updated_at: now };
}

function toConversation(row) {
  return {
    id: row.id,
    title: row.title,
    panel: JSON.parse(row.panel_json),
    aggregator: row.aggregator,
    created_at: row.created_at,
    updated_at: row.updated_at,
    summary: row.summary ?? null,
    summary_message_count: row.summary_message_count ?? 0,
  };
}

export function getConversation(id) {
  const row = stmts.getConversation.get(id);
  return row ? toConversation(row) : null;
}

export function updateConversationSummary(id, summary, messageCount) {
  stmts.updateSummary.run(summary ?? null, messageCount ?? 0, id);
}

export function listConversations({ limit = CONVERSATION_PAGE_SIZE, offset = 0 } = {}) {
  return stmts.listConversations.all(limit, offset).map(toConversation);
}

export function deleteConversation(id) {
  stmts.deleteConversation.run(id);
}

// ---------- messages ----------

export function addMessage(conversationId, role, content, { isError = false } = {}) {
  const id = randomUUID();
  const now = Date.now();
  stmts.insertMessage.run(id, conversationId, role, content, now, isError ? 1 : 0);
  return { id, conversationId, role, content, created_at: now, is_error: isError ? 1 : 0 };
}

export function countMessages(conversationId) {
  return stmts.countMessages.get(conversationId).n;
}

export function countHistoryMessages(conversationId) {
  return stmts.countHistoryMessages.get(conversationId).n;
}

export function listRecentHistory(conversationId, limit) {
  return stmts.listRecentHistory.all(conversationId, limit);
}

export function listOlderHistory(conversationId, limit) {
  return stmts.listOlderHistory.all(conversationId, limit);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function rowToPanel(row) {
  if (!row.panel_id) return null;
  return {
    id: row.panel_id,
    drafts: parseJson(row.drafts_json, []),
    revisions: parseJson(row.revisions_json, []),
    synthesis_text: row.synthesis_text,
    synthesis_model: row.synthesis_model,
    error: row.panel_error,
    ms_total: row.ms_total,
    created_at: row.panel_created_at,
    mode: row.mode ?? null,
  };
}

/**
 * Página de mensagens com o painel já embutido (uma query só).
 * Retorna as `limit` mensagens mais recentes anteriores ao cursor `before`, em
 * ordem cronológica, mais o cursor para carregar as anteriores.
 */
export function listConversationMessages(
  conversationId,
  { limit = MESSAGE_PAGE_SIZE, before = null } = {}
) {
  const cursor = before ?? Number.MAX_SAFE_INTEGER;
  const rows = stmts.listMessagesPage.all(conversationId, cursor, limit);
  const messages = rows.map((row) => ({
    id: row.id,
    role: row.role,
    content: row.content,
    created_at: row.created_at,
    is_error: Boolean(row.is_error),
    panel: rowToPanel(row),
  }));
  // Cursor opaco = rowid da mensagem mais antiga da página.
  const oldest = rows.length > 0 ? rows[0].seq : cursor;
  const remaining = stmts.countMessagesBefore.get(conversationId, oldest).n;
  return {
    messages,
    has_more: remaining > 0,
    next_before: remaining > 0 ? oldest : null,
  };
}

// ---------- escrita de turno (atômica) ----------

const insertAssistantTurn = db.transaction(
  (conversationId, { content, isError, drafts, revisions, synthesis_text, synthesis_model, error, ms_total, mode }) => {
    const messageId = randomUUID();
    const now = Date.now();
    stmts.insertMessage.run(messageId, conversationId, 'assistant', content, now, isError ? 1 : 0);
    stmts.insertPanelRun.run(
      randomUUID(),
      messageId,
      JSON.stringify(drafts ?? []),
      JSON.stringify(revisions ?? []),
      synthesis_text ?? null,
      synthesis_model ?? null,
      error ?? null,
      ms_total ?? 0,
      now,
      mode ?? null
    );
    stmts.touchConversation.run(now, null, conversationId);
    return { id: messageId, created_at: now };
  }
);

/**
 * Grava a mensagem do assistente + o painel + o touch da conversa numa única
 * transação. Ou tudo entra, ou nada — sem mensagem órfã sem painel.
 */
export function saveAssistantTurn(conversationId, turn) {
  return insertAssistantTurn(conversationId, turn);
}

export function closeDb() {
  try {
    db.close();
  } catch {
    /* já fechado */
  }
}

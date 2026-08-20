// config.js — toda leitura de env num lugar só, com validação e defaults.
import 'dotenv/config';

function positive(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function count(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function ratio(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

function flag(value, fallback) {
  if (value == null || value === '') return fallback;
  return !/^(false|0|no|off)$/i.test(String(value).trim());
}

function list(value, fallback = []) {
  if (!value) return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const NODE_ENV = process.env.NODE_ENV || 'development';
// 3030 pra bater com o proxy do Vite sem depender do .env estar presente.
export const PORT = positive(process.env.PORT, 3030);

// ---------- rede / segurança ----------
export const CORS_ORIGINS = list(process.env.CORS_ORIGINS, [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:4173',
]);
export const CORS_ALLOW_ANY = flag(process.env.CORS_ALLOW_ANY, false);
// Se definido, toda requisição precisa mandar `Authorization: Bearer <token>`
// (ou header `x-api-token`). Vazio = aberto, só faz sentido em localhost.
export const API_TOKEN = (process.env.API_TOKEN || '').trim();
export const RATE_LIMIT_WINDOW_MS = positive(process.env.RATE_LIMIT_WINDOW_MS, 60_000);
export const RATE_LIMIT_MAX = count(process.env.RATE_LIMIT_MAX, 120);
// /chat/stream custa dinheiro real — limite próprio, bem mais apertado.
export const CHAT_RATE_LIMIT_MAX = count(process.env.CHAT_RATE_LIMIT_MAX, 20);
export const MAX_PROMPT_CHARS = positive(process.env.MAX_PROMPT_CHARS, 32_000);
export const MAX_PANEL_SIZE = positive(process.env.MAX_PANEL_SIZE, 6);
export const JSON_BODY_LIMIT = process.env.JSON_BODY_LIMIT || '256kb';
// Comentário SSE periódico pra proxies não derrubarem a conexão em fases silenciosas.
export const SSE_HEARTBEAT_MS = positive(process.env.SSE_HEARTBEAT_MS, 15_000);

// ---------- chamadas de modelo ----------
// Idle: reinicia a cada chunk recebido — stream vivo nunca é morto por lentidão total.
export const MODEL_IDLE_TIMEOUT_MS = positive(
  process.env.MODEL_IDLE_TIMEOUT_MS ?? process.env.MODEL_TIMEOUT_MS,
  60_000
);
// Hard: teto absoluto de uma tentativa, mesmo que esteja produzindo tokens.
export const MODEL_HARD_TIMEOUT_MS = positive(process.env.MODEL_HARD_TIMEOUT_MS, 180_000);
export const MAX_RETRIES = count(process.env.MODEL_MAX_RETRIES, 2);

// ---------- contexto ----------
export const HISTORY_WINDOW = positive(process.env.HISTORY_WINDOW, 6);
export const SUMMARIZE_AFTER = positive(process.env.SUMMARIZE_AFTER, 10);
export const SUMMARIZE_AFTER_CHARS = positive(process.env.SUMMARIZE_AFTER_CHARS, 4000);
export const DRAFT_TRUNCATE_CHARS = positive(process.env.DRAFT_TRUNCATE_CHARS, 4000);

// ---------- caps de saída por rodada ----------
export const MAX_TOKENS_DRAFT = positive(process.env.MAX_TOKENS_DRAFT, 800);
export const MAX_TOKENS_DRAFT_CODE = positive(process.env.MAX_TOKENS_DRAFT_CODE, 1200);
export const MAX_TOKENS_REVISION = positive(process.env.MAX_TOKENS_REVISION, 700);
export const MAX_TOKENS_SYNTHESIS = positive(process.env.MAX_TOKENS_SYNTHESIS, 1000);
export const MAX_TOKENS_SUMMARY = positive(process.env.MAX_TOKENS_SUMMARY, 200);

// ---------- painel adaptativo em contexto de código ----------
export const ADAPTIVE_PANEL_CODE = flag(process.env.ADAPTIVE_PANEL_CODE, true);
export const ADAPTIVE_PANEL_CODE_SIZE = positive(process.env.ADAPTIVE_PANEL_CODE_SIZE, 2);

// ---------- thresholds de similaridade ----------
export const SIMILARITY_SKIP_CRITIQUE = ratio(process.env.SIMILARITY_SKIP_CRITIQUE, 0.3);
export const SIMILARITY_EARLY_EXIT = ratio(process.env.SIMILARITY_EARLY_EXIT, 0.55);
export const SIMILARITY_DEDUP = ratio(process.env.SIMILARITY_DEDUP, 0.7);

// ---------- persistência ----------
export const DB_PATH = process.env.DB_PATH || './data.db';
export const CONVERSATION_PAGE_SIZE = positive(process.env.CONVERSATION_PAGE_SIZE, 200);
export const MESSAGE_PAGE_SIZE = positive(process.env.MESSAGE_PAGE_SIZE, 200);

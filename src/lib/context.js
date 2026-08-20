// context.js — janela de histórico + sumarização do que ficou pra trás.
import {
  HISTORY_WINDOW,
  MAX_TOKENS_SUMMARY,
  SUMMARIZE_AFTER,
  SUMMARIZE_AFTER_CHARS,
} from '../config.js';
import {
  countHistoryMessages,
  getConversation,
  listOlderHistory,
  listRecentHistory,
  updateConversationSummary,
} from '../db.js';
import { defaultSummarizerModelId } from '../models.js';
import { collectModel } from './model-stream.js';
import { PROMPT_SUMMARIZE } from './prompts.js';
import { C, log } from '../logger.js';

/**
 * Garante que existe summary cobrindo o histórico antigo (tudo exceto as
 * HISTORY_WINDOW últimas mensagens). Gera/regenera só quando necessário.
 * Retorna a string do summary, ou null se ainda não chegou no limiar.
 */
export async function ensureSummary(conversationId, parentSignal) {
  const conv = getConversation(conversationId);
  if (!conv) return null;

  const total = countHistoryMessages(conversationId);
  if (total <= SUMMARIZE_AFTER) return conv.summary || null;

  const olderCount = total - HISTORY_WINDOW;
  if (olderCount <= 0) return conv.summary || null;

  // Já temos summary cobrindo até olderCount? Reusa.
  if (conv.summary && (conv.summary_message_count || 0) >= olderCount) return conv.summary;

  const older = listOlderHistory(conversationId, olderCount);
  const totalChars = older.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  // Conversas curtas-mas-numerosas não pagam o custo de uma chamada extra.
  if (totalChars < SUMMARIZE_AFTER_CHARS) return conv.summary || null;

  const summarizerId = defaultSummarizerModelId();
  if (!summarizerId) return conv.summary || null;

  const transcript = older
    .map((m) => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`)
    .join('\n\n');

  const started = Date.now();
  const r = await collectModel({
    id: summarizerId,
    system: PROMPT_SUMMARIZE,
    messages: [{ role: 'user', content: transcript }],
    maxOutputTokens: MAX_TOKENS_SUMMARY,
    etiqueta: 'sumário',
    parentSignal,
  });

  if (r.erro || !r.texto.trim()) {
    if (r.erro && !r.aborted) {
      log(C.yellow, '⚠', `falha ao sumarizar conv=${conversationId}: ${r.erro}`);
    }
    return conv.summary || null;
  }

  const summary = r.texto.trim();
  updateConversationSummary(conversationId, summary, olderCount);
  log(
    C.cyan,
    '∑',
    `sumário regenerado conv=${conversationId} (${olderCount} msgs antigas, ${Date.now() - started}ms)`
  );
  return summary;
}

/** Últimas HISTORY_WINDOW mensagens úteis (turnos com erro ficam de fora). */
export function loadWindowedMessages(conversationId) {
  return listRecentHistory(conversationId, HISTORY_WINDOW).map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

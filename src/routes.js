// routes.js — endpoints REST + o SSE de chat. Handlers finos: validam e delegam.
import { Router } from 'express';
import {
  CHAT_RATE_LIMIT_MAX,
  CONVERSATION_PAGE_SIZE,
  MAX_PANEL_SIZE,
  MAX_PROMPT_CHARS,
  MESSAGE_PAGE_SIZE,
} from './config.js';
import {
  deleteConversation,
  getConversation,
  listConversationMessages,
  listConversations,
} from './db.js';
import {
  defaultAggregatorId,
  defaultModelIds,
  isModelAvailable,
  listModels,
  listUnavailableModels,
  missingProviders,
} from './models.js';
import { openSSE } from './lib/sse.js';
import { rateLimiter } from './lib/middleware.js';
import { runChatTurn } from './chat/run.js';

const VALID_MODES = new Set(['auto', 'single_fast', 'panel_no_critique', 'panel_full']);

function intParam(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function createRouter() {
  const router = Router();
  const chatLimiter = rateLimiter({ max: CHAT_RATE_LIMIT_MAX, name: 'chat' });

  router.get('/health', (_req, res) => {
    res.json({
      ok: true,
      uptime_s: Math.round(process.uptime()),
      providers_missing: missingProviders().map((p) => p.provider),
    });
  });

  router.get('/models', (_req, res) => {
    res.json({
      models: listModels(),
      unavailable: listUnavailableModels(),
      defaults: defaultModelIds(),
      default_aggregator: defaultAggregatorId(),
    });
  });

  router.get('/conversations', (req, res) => {
    const limit = intParam(req.query.limit, CONVERSATION_PAGE_SIZE, { max: 500 });
    const offset = intParam(req.query.offset, 0, { min: 0 });
    res.json({ conversations: listConversations({ limit, offset }) });
  });

  router.get('/conversations/:id', (req, res) => {
    const conversation = getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ error: 'not found' });

    const limit = intParam(req.query.limit, MESSAGE_PAGE_SIZE, { max: 500 });
    const before = req.query.before ? intParam(req.query.before, null, { min: 0 }) : null;
    const page = listConversationMessages(req.params.id, { limit, before });

    res.json({
      conversation,
      messages: page.messages,
      has_more: page.has_more,
      next_before: page.next_before,
    });
  });

  router.delete('/conversations/:id', (req, res) => {
    if (!getConversation(req.params.id)) return res.status(404).json({ error: 'not found' });
    deleteConversation(req.params.id);
    res.json({ ok: true });
  });

  router.post('/chat/stream', chatLimiter, async (req, res) => {
    const {
      prompt,
      conversation_id: conversationId,
      modelos: requestedIds,
      agregador: requestedAggregator,
      mode: requestedModeInput,
    } = req.body ?? {};

    // ---- validação (tudo antes de abrir o SSE, pra poder responder com status) ----
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      return res.status(400).json({ error: 'Body deve ter { prompt: string }' });
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      return res.status(413).json({
        error: `Prompt tem ${prompt.length} caracteres; o limite é ${MAX_PROMPT_CHARS}.`,
      });
    }

    const fallbackIds = defaultModelIds();
    if (fallbackIds.length === 0) {
      return res.status(503).json({
        error: 'Nenhum provider configurado. Defina ao menos uma API key no .env.',
      });
    }

    let modelIds =
      Array.isArray(requestedIds) && requestedIds.length > 0 ? [...new Set(requestedIds)] : fallbackIds;
    if (modelIds.some((id) => typeof id !== 'string')) {
      return res.status(400).json({ error: 'modelos deve ser um array de strings' });
    }
    if (modelIds.length > MAX_PANEL_SIZE) {
      return res.status(400).json({ error: `O painel aceita no máximo ${MAX_PANEL_SIZE} modelos.` });
    }
    const unknown = modelIds.filter((id) => !isModelAvailable(id));
    if (unknown.length > 0) {
      return res
        .status(400)
        .json({ error: `Modelos desconhecidos ou sem API key: ${unknown.join(', ')}` });
    }

    const aggregator = requestedAggregator || defaultAggregatorId();
    if (!isModelAvailable(aggregator)) {
      return res.status(400).json({ error: `Agregador indisponível: ${aggregator}` });
    }

    const requestedMode =
      requestedModeInput && VALID_MODES.has(requestedModeInput) ? requestedModeInput : 'auto';

    let conversation = null;
    if (conversationId) {
      conversation = getConversation(conversationId);
      if (!conversation) return res.status(404).json({ error: 'conversation_id desconhecido' });
    }

    // ---- a partir daqui é SSE: erros viram eventos, não status ----
    const abortCtrl = new AbortController();
    const sse = openSSE(res, {
      onClose: () => abortCtrl.abort(new Error('client disconnected')),
    });

    await runChatTurn({
      sse,
      abortCtrl,
      params: {
        prompt: prompt.trim(),
        conversationId: conversationId ?? null,
        conversation,
        modelIds,
        aggregator,
        requestedMode,
      },
    });
  });

  return router;
}

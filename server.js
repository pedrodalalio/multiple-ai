import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { streamText } from 'ai';
import {
  MODELS,
  listModels,
  DEFAULT_MODEL_IDS,
  DEFAULT_AGGREGATOR_ID,
  DEFAULT_CODER_MODEL_ID,
  DEFAULT_SUMMARIZER_MODEL_ID,
} from './models.js';
import {
  createConversation,
  touchConversation,
  getConversation,
  listConversations,
  deleteConversation,
  addMessage,
  listMessages,
  listRecentMessages,
  listOlderMessages,
  countMessages,
  updateConversationSummary,
  savePanelRun,
  getPanelRunByMessage,
} from './db.js';
import {
  classifyPrompt,
  decideAfterDrafts,
  dedupeDrafts,
  hasCodeSignals,
  isSelfContainedPrompt,
} from './classify.js';

const TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS) || 60_000;
const MAX_RETRIES = Number(process.env.MODEL_MAX_RETRIES) || 2;
// Quantas mensagens do histórico mandar pra cada modelo (incluindo a atual).
// O resto vira summary cacheado. 6 = ~3 turnos.
const HISTORY_WINDOW = Number(process.env.HISTORY_WINDOW) || 6;
// A partir de quantas mensagens totais começamos a sumarizar o histórico antigo.
const SUMMARIZE_AFTER = Number(process.env.SUMMARIZE_AFTER) || 10;
// Mas só sumariza se o histórico antigo somar pelo menos esse tanto de chars.
// Conversas curtas-mas-numerosas não pagam o custo de uma chamada extra.
const SUMMARIZE_AFTER_CHARS = Number(process.env.SUMMARIZE_AFTER_CHARS) || 4000;
// Tamanho máximo (em caracteres) de cada rascunho enviado para R2/R3.
// Rascunhos grandes são truncados pra economizar input nas rodadas seguintes.
const DRAFT_TRUNCATE_CHARS = Number(process.env.DRAFT_TRUNCATE_CHARS) || 4000;

// Caps de saída por rodada — controla output e, em cascata, input das próximas.
const MAX_TOKENS_DRAFT = Number(process.env.MAX_TOKENS_DRAFT) || 800;
const MAX_TOKENS_DRAFT_CODE = Number(process.env.MAX_TOKENS_DRAFT_CODE) || 1200;
const MAX_TOKENS_REVISION = Number(process.env.MAX_TOKENS_REVISION) || 700;
const MAX_TOKENS_SYNTHESIS = Number(process.env.MAX_TOKENS_SYNTHESIS) || 1000;
const MAX_TOKENS_SUMMARY = Number(process.env.MAX_TOKENS_SUMMARY) || 200;

// Em painel + contexto de código, trim para esse tamanho de painel (default 2).
// 1 coder + 1 alternativo costuma bastar pra revisar código.
const ADAPTIVE_PANEL_CODE = (process.env.ADAPTIVE_PANEL_CODE ?? 'true') !== 'false';
const ADAPTIVE_PANEL_CODE_SIZE = Number(process.env.ADAPTIVE_PANEL_CODE_SIZE) || 2;

const VALID_MODES = new Set(['auto', 'single_fast', 'panel_no_critique', 'panel_full']);

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  gray: '\x1b[90m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  bold: '\x1b[1m',
};

const ts = () => new Date().toISOString().slice(11, 23);
const log = (color, prefix, msg) =>
  console.log(`${C.gray}${ts()}${C.reset} ${color}${prefix}${C.reset} ${msg}`);

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use((req, _res, next) => {
  log(C.gray, '→', `${C.bold}${req.method}${C.reset} ${req.path}`);
  next();
});

// ---------- prompts (enxutos pra economizar tokens) ----------

const PROMPT_CRITICA = `Você viu sua resposta inicial e as dos outros do painel. Produza, nesta ordem:

[CRÍTICA]
Análise breve: erros factuais, lacunas, divergências e onde você estava errado.

[RESPOSTA REVISADA]
Sua resposta final à pergunta original, incorporando o que aprendeu.

Use exatamente esses marcadores, sem nada antes ou depois.`;

// Versão enxuta usada quando o prompt é de código. ~30 tok vs ~70.
const PROMPT_CRITICA_CODE = `Compare sua resposta com as outras. Produza, nesta ordem:

[CRÍTICA]
Bugs, edge cases ou erros que você ou os outros cometeram. Curto.

[RESPOSTA REVISADA]
Código revisado, em bloco \`\`\`. Sem preâmbulo.

Use exatamente esses marcadores.`;

const PROMPT_SINTESE = `Você é o agregador final do painel. Consolide as respostas revisadas numa única resposta autoritativa. Não mencione modelos nem o processo de debate. Onde houver convergência, é provavelmente o caminho. Onde houver divergência, decida pelo mérito técnico ou sinalize incerteza.`;

const PROMPT_SINTESE_DRAFTS = `Você é o agregador do painel. Recebeu os rascunhos paralelos dos modelos para a mesma pergunta. Consolide numa única resposta autoritativa, escolhendo o melhor de cada um e corrigindo erros. Não mencione modelos nem o processo.`;

// Adicionado quando o roteador detecta pergunta de código.
const PROMPT_CODER_SUFFIX = `Para perguntas de código: responda com o código primeiro, em bloco \`\`\`. Sem preâmbulo. Explicação adicional só se necessária para entender, em no máximo 2 linhas. Não repita a pergunta.`;

const PROMPT_SUMMARIZE = `Resuma a conversa abaixo em até 350 caracteres, em terceira pessoa. Inclua: o que o usuário pediu, decisões importantes, código gerado relevante. Sem floreios — só o resumo, direto.`;

// ---------- helpers ----------

function parseCriticaERevisao(texto) {
  if (!texto) return { critica: '', resposta_revisada: '' };
  const matchCritica = texto.match(/\[CR[ÍI]TICA\]([\s\S]*?)(?=\[RESPOSTA\s+REVISADA\]|$)/i);
  const matchRevisao = texto.match(/\[RESPOSTA\s+REVISADA\]([\s\S]*)/i);
  if (matchRevisao) {
    return {
      critica: matchCritica ? matchCritica[1].trim() : '',
      resposta_revisada: matchRevisao[1].trim(),
    };
  }
  // Fallback heurístico: tentar achar último parágrafo grande como resposta revisada
  const trimmed = texto.trim();
  const parts = trimmed.split(/\n{2,}/);
  if (parts.length >= 2) {
    const half = Math.floor(parts.length / 2);
    return {
      critica: parts.slice(0, half).join('\n\n').trim(),
      resposta_revisada: parts.slice(half).join('\n\n').trim(),
    };
  }
  return { critica: '', resposta_revisada: trimmed };
}

function isTransientError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return false;
  const msg = (err.message || String(err)).toLowerCase();
  const status = err.statusCode || err.status;
  if (status && [408, 425, 429, 500, 502, 503, 504].includes(status)) return true;
  return /rate.?limit|timeout|econnreset|etimedout|fetch failed|socket hang up|temporarily|overloaded|503|502|504/i.test(
    msg
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Streamed model call. onDelta receives each text chunk.
 * Retries on transient errors (network / 429 / 5xx).
 * The parent abortSignal cancels and is NOT retried.
 */
async function streamModelo({
  id,
  messages,
  system,
  etiqueta = '',
  onDelta,
  parentSignal,
  maxOutputTokens,
}) {
  const entry = MODELS[id];
  if (!entry) throw new Error(`Modelo desconhecido: ${id}`);
  const tag = etiqueta ? `[${etiqueta}] ` : '';

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (parentSignal?.aborted) {
      const e = new Error('aborted by client');
      e.name = 'AbortError';
      throw e;
    }
    const inicio = Date.now();
    log(
      C.cyan,
      '⟳',
      `${tag}${C.bold}${id}${C.reset} ${C.dim}iniciando${attempt > 0 ? ` (retry ${attempt})` : ''}...${C.reset}`
    );

    const localCtrl = new AbortController();
    const timeoutId = setTimeout(() => localCtrl.abort(new Error('timeout')), TIMEOUT_MS);
    const onParentAbort = () => localCtrl.abort(parentSignal.reason);
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    try {
      let streamErr = null;
      const result = streamText({
        model: entry.model,
        system,
        messages,
        maxOutputTokens,
        abortSignal: localCtrl.signal,
        onError: ({ error }) => {
          streamErr = error;
        },
      });

      let textoCompleto = '';
      for await (const delta of result.textStream) {
        textoCompleto += delta;
        if (onDelta) onDelta(delta);
      }
      if (streamErr) throw streamErr;
      const usage = await result.usage.catch(() => null);
      const ms = Date.now() - inicio;
      const tokens = usage
        ? `${C.dim}(${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out)${C.reset}`
        : '';
      log(C.green, '✓', `${tag}${C.bold}${id}${C.reset} ${ms}ms ${tokens}`);
      return {
        model: id,
        label: entry.label,
        provider: entry.provider,
        ms,
        tokens_input: usage?.inputTokens ?? null,
        tokens_output: usage?.outputTokens ?? null,
        texto: textoCompleto,
      };
    } catch (err) {
      const ms = Date.now() - inicio;
      lastErr = err;
      const mensagem = err instanceof Error ? err.message : String(err);

      if (parentSignal?.aborted) {
        log(C.yellow, '⊘', `${tag}${C.bold}${id}${C.reset} ${ms}ms cancelado pelo cliente`);
        const e = new Error('aborted by client');
        e.name = 'AbortError';
        throw e;
      }

      const transient = isTransientError(err);
      if (transient && attempt < MAX_RETRIES) {
        const backoff = 400 * Math.pow(2, attempt) + Math.floor(Math.random() * 200);
        log(
          C.yellow,
          '↻',
          `${tag}${C.bold}${id}${C.reset} ${ms}ms falhou transiente (${mensagem}), retry em ${backoff}ms`
        );
        await sleep(backoff);
        continue;
      }

      log(C.red, '✗', `${tag}${C.bold}${id}${C.reset} ${ms}ms ${C.red}${mensagem}${C.reset}`);
      return {
        model: id,
        label: entry.label,
        provider: entry.provider,
        ms,
        erro: mensagem,
        texto: '',
      };
    } finally {
      clearTimeout(timeoutId);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  // shouldn't reach
  return {
    model: id,
    label: entry.label,
    provider: entry.provider,
    ms: 0,
    erro: lastErr ? lastErr.message : 'erro desconhecido',
    texto: '',
  };
}

// ---------- contexto: janela + sumarização ----------

function makeSystem(...parts) {
  return parts.filter((p) => p && p.trim()).join('\n\n') || undefined;
}

function truncateDraft(texto) {
  if (!texto) return '';
  if (texto.length <= DRAFT_TRUNCATE_CHARS) return texto;
  return texto.slice(0, DRAFT_TRUNCATE_CHARS) + '\n…[truncado]';
}

/**
 * Garante que existe summary cobrindo o histórico antigo (tudo exceto
 * HISTORY_WINDOW últimas mensagens). Gera/regenera só quando necessário.
 * Retorna a string do summary (ou null se ainda não chegou no limiar).
 */
async function ensureSummary(conversationId, abortSignal) {
  const conv = getConversation(conversationId);
  if (!conv) return null;
  const total = countMessages(conversationId);
  if (total <= SUMMARIZE_AFTER) return conv.summary || null;

  const olderCount = total - HISTORY_WINDOW;
  if (olderCount <= 0) return conv.summary || null;

  // Já temos summary cobrindo até olderCount? Reusa.
  if (conv.summary && (conv.summary_message_count || 0) >= olderCount) {
    return conv.summary;
  }

  const older = listOlderMessages(conversationId, olderCount);
  const totalChars = older.reduce((sum, m) => sum + (m.content?.length || 0), 0);
  // Conversas curtas-mas-numerosas: não vale o custo de uma chamada de sumarização.
  if (totalChars < SUMMARIZE_AFTER_CHARS) return conv.summary || null;

  const transcript = older
    .map((m) => `${m.role === 'user' ? 'Usuário' : 'Assistente'}: ${m.content}`)
    .join('\n\n');

  const summModel = MODELS[DEFAULT_SUMMARIZER_MODEL_ID];
  if (!summModel) return conv.summary || null;

  try {
    const inicio = Date.now();
    const result = streamText({
      model: summModel.model,
      system: PROMPT_SUMMARIZE,
      messages: [{ role: 'user', content: transcript }],
      maxOutputTokens: MAX_TOKENS_SUMMARY,
      abortSignal,
    });
    let texto = '';
    for await (const delta of result.textStream) texto += delta;
    const summary = texto.trim();
    if (summary) {
      updateConversationSummary(conversationId, summary, olderCount);
      log(C.cyan, '∑', `sumário regenerado conv=${conversationId} (${olderCount} msgs antigas, ${Date.now() - inicio}ms)`);
      return summary;
    }
  } catch (e) {
    log(C.yellow, '⚠', `falha ao sumarizar conv=${conversationId}: ${e.message}`);
  }
  return conv.summary || null;
}

function loadWindowedMessages(conversationId) {
  return listRecentMessages(conversationId, HISTORY_WINDOW).map((m) => ({
    role: m.role,
    content: m.content,
  }));
}

// ---------- REST endpoints (read-only / management) ----------

app.get('/models', (_req, res) => {
  res.json({
    models: listModels(),
    defaults: DEFAULT_MODEL_IDS,
    default_aggregator: DEFAULT_AGGREGATOR_ID,
  });
});

app.get('/conversations', (_req, res) => {
  res.json({ conversations: listConversations() });
});

app.get('/conversations/:id', (req, res) => {
  const conv = getConversation(req.params.id);
  if (!conv) return res.status(404).json({ error: 'not found' });
  const messages = listMessages(req.params.id).map((m) => {
    const panel = m.role === 'assistant' ? getPanelRunByMessage(m.id) : null;
    return { ...m, panel };
  });
  res.json({ conversation: conv, messages });
});

app.delete('/conversations/:id', (req, res) => {
  deleteConversation(req.params.id);
  res.json({ ok: true });
});

// ---------- SSE chat ----------

app.post('/chat/stream', async (req, res) => {
  const {
    prompt,
    conversation_id: convIdInput,
    modelos: requestedIds,
    agregador: agregadorInput,
    mode: modeInput,
  } = req.body ?? {};

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Body deve ter { prompt: string }' });
  }

  const idsRequested = Array.isArray(requestedIds) && requestedIds.length > 0 ? requestedIds : DEFAULT_MODEL_IDS;
  const desconhecidos = idsRequested.filter((id) => !MODELS[id]);
  if (desconhecidos.length > 0) {
    return res.status(400).json({ error: `Modelos desconhecidos: ${desconhecidos.join(', ')}` });
  }
  const agregador = agregadorInput || DEFAULT_AGGREGATOR_ID;
  if (!MODELS[agregador]) {
    return res.status(400).json({ error: `Agregador desconhecido: ${agregador}` });
  }
  const modeRequested = modeInput && VALID_MODES.has(modeInput) ? modeInput : 'auto';

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const abortCtrl = new AbortController();
  let clientGone = false;
  res.on('close', () => {
    if (res.writableEnded) return;
    clientGone = true;
    abortCtrl.abort(new Error('client disconnected'));
  });

  // Conversation setup
  let conversation;
  if (convIdInput) {
    conversation = getConversation(convIdInput);
    if (!conversation) {
      send('error', { error: 'conversation_id desconhecido' });
      return res.end();
    }
  } else {
    const title = prompt.length > 60 ? prompt.slice(0, 60) + '…' : prompt;
    conversation = createConversation({ title, panel: idsRequested, aggregator: agregador });
  }

  const userMessage = addMessage(conversation.id, 'user', prompt);

  // ---- Decide modo (override > classificação automática) ----
  const classified = classifyPrompt(prompt);
  const mode = modeRequested === 'auto' ? classified : modeRequested;
  const isCodeContext = classified === 'single_fast' || hasCodeSignals(prompt);
  const coderSuffix = isCodeContext ? PROMPT_CODER_SUFFIX : null;

  // ---- Painel adaptativo: em código + painel, 2 modelos costumam bastar ----
  let ids = idsRequested;
  let panelTrimmed = false;
  if (
    ADAPTIVE_PANEL_CODE &&
    isCodeContext &&
    (mode === 'panel_full' || mode === 'panel_no_critique') &&
    idsRequested.length > ADAPTIVE_PANEL_CODE_SIZE
  ) {
    // Prioriza o coder model se estiver na seleção, depois os restantes na ordem.
    const coderFirst = idsRequested.includes(DEFAULT_CODER_MODEL_ID)
      ? [DEFAULT_CODER_MODEL_ID, ...idsRequested.filter((x) => x !== DEFAULT_CODER_MODEL_ID)]
      : idsRequested;
    ids = coderFirst.slice(0, ADAPTIVE_PANEL_CODE_SIZE);
    panelTrimmed = true;
  }
  const agregadorEfetivo = ids.includes(agregador) ? agregador : ids[0];

  // ---- Contexto: janela curta + summary do que ficou pra trás ----
  const summary = await ensureSummary(conversation.id, abortCtrl.signal).catch(() => null);
  const windowedMessages = loadWindowedMessages(conversation.id);
  const priorHistory = windowedMessages.slice(0, -1);
  const summaryPrefix = summary ? `Resumo da conversa anterior:\n${summary}` : '';

  // ---- Prompt auto-contido (tem código fenced e não referencia histórico):
  //      manda só a mensagem atual, sem priorHistory. Corta input significativo. ----
  const selfContained = isSelfContainedPrompt(prompt);
  const effectiveR1Messages = selfContained
    ? [windowedMessages[windowedMessages.length - 1]]
    : windowedMessages;
  const effectivePriorHistory = selfContained ? [] : priorHistory;

  const promptPreview = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
  log(
    C.magenta,
    '◆',
    `${C.bold}/chat/stream${C.reset} conv=${conversation.id} mode=${C.bold}${mode}${C.reset}${classified !== mode ? ` (auto=${classified}, forçado=${modeRequested})` : ''}${isCodeContext ? ' [código]' : ''}${summary ? ' [com sumário]' : ''}${selfContained ? ' [self-contained]' : ''}${panelTrimmed ? ` [painel ${idsRequested.length}→${ids.length}]` : ''}`
  );
  log(C.magenta, '◆', `prompt: ${C.dim}"${promptPreview}"${C.reset}`);

  const inicioTotal = Date.now();

  try {
    // ============================================================
    // MODO single_fast — 1 modelo só, sem painel, sem síntese.
    // ============================================================
    if (mode === 'single_fast') {
      const onlyId = MODELS[DEFAULT_CODER_MODEL_ID] ? DEFAULT_CODER_MODEL_ID : ids[0];
      const onlyEntry = MODELS[onlyId];
      const draftCap = isCodeContext ? MAX_TOKENS_DRAFT_CODE : MAX_TOKENS_DRAFT;

      send('meta', {
        conversation_id: conversation.id,
        user_message_id: userMessage.id,
        panel: [{ id: onlyId, label: onlyEntry.label, provider: onlyEntry.provider }],
        aggregator: onlyId,
        mode,
        classified,
      });

      send('phase', { phase: 'drafts' });
      send('draft_start', { model: onlyId });

      const r = await streamModelo({
        id: onlyId,
        messages: effectiveR1Messages,
        system: makeSystem(summaryPrefix, coderSuffix),
        etiqueta: 'único',
        parentSignal: abortCtrl.signal,
        maxOutputTokens: draftCap,
        onDelta: (delta) => send('draft_delta', { model: onlyId, delta }),
      });
      send('draft_done', {
        model: onlyId,
        ms: r.ms,
        tokens_input: r.tokens_input,
        tokens_output: r.tokens_output,
        erro: r.erro ?? null,
        texto: r.texto,
      });

      // Reflete o rascunho como síntese (pra UI mostrar a resposta no card final)
      send('phase', { phase: 'synthesis' });
      send('synthesis_start', { model: onlyId });
      if (r.erro) {
        send('synthesis_done', { model: null, erro: r.erro, texto: '' });
      } else {
        send('synthesis_done', {
          model: onlyId,
          ms: r.ms,
          erro: null,
          texto: r.texto,
          tokens_input: r.tokens_input,
          tokens_output: r.tokens_output,
        });
      }

      const msTotal = Date.now() - inicioTotal;
      const assistantContent = r.erro ? `[erro] ${r.erro}` : r.texto;
      const asstMsg = addMessage(conversation.id, 'assistant', assistantContent);
      savePanelRun(asstMsg.id, {
        drafts: [r],
        revisions: [],
        synthesis_text: r.erro ? null : r.texto,
        synthesis_model: r.erro ? null : onlyId,
        error: r.erro ?? null,
        ms_total: msTotal,
        mode,
      });
      touchConversation(conversation.id);

      send('done', {
        ms_total: msTotal,
        assistant_message_id: asstMsg.id,
        synthesis_error: r.erro ?? null,
      });
      res.end();
      log(
        r.erro ? C.yellow : C.green,
        r.erro ? '⚠' : '✓',
        `${C.bold}/chat/stream${C.reset} mode=${mode} concluído em ${msTotal}ms`
      );
      return;
    }

    // ============================================================
    // MODO panel_* — N modelos
    // ============================================================
    send('meta', {
      conversation_id: conversation.id,
      user_message_id: userMessage.id,
      panel: ids.map((id) => ({ id, label: MODELS[id].label, provider: MODELS[id].provider })),
      aggregator: agregadorEfetivo,
      mode,
      classified,
    });

    // ---------- Round 1: rascunhos paralelos ----------
    send('phase', { phase: 'drafts' });
    ids.forEach((id) => send('draft_start', { model: id }));

    const r1System = makeSystem(summaryPrefix, coderSuffix);
    const draftCap = isCodeContext ? MAX_TOKENS_DRAFT_CODE : MAX_TOKENS_DRAFT;
    const rascunhos = await Promise.all(
      ids.map((id) =>
        streamModelo({
          id,
          messages: effectiveR1Messages,
          system: r1System,
          etiqueta: 'rascunho',
          parentSignal: abortCtrl.signal,
          maxOutputTokens: draftCap,
          onDelta: (delta) => send('draft_delta', { model: id, delta }),
        }).then((r) => {
          send('draft_done', {
            model: id,
            ms: r.ms,
            tokens_input: r.tokens_input,
            tokens_output: r.tokens_output,
            erro: r.erro ?? null,
            texto: r.texto,
          });
          return r;
        })
      )
    );

    if (clientGone) return;

    const rascunhosOk = rascunhos.filter((r) => !r.erro && r.texto?.trim().length > 0);

    // ---------- Decisão pós-R1 ----------
    // panel_no_critique  → sempre pula R2.
    // panel_full         → similaridade decide: pular R2, early-exit, ou rodar R2.
    let pularR2 = mode === 'panel_no_critique';
    let earlyExit = false;
    let bestDraft = null;
    let similarity = null;

    if (mode === 'panel_full' && rascunhosOk.length >= 2) {
      const decision = decideAfterDrafts(rascunhosOk);
      similarity = decision.similarity;
      pularR2 = decision.skip;
      earlyExit = decision.earlyExit;
      bestDraft = rascunhosOk[decision.bestIndex];
      log(
        C.cyan,
        '∼',
        `similaridade=${similarity.toFixed(2)} → ${earlyExit ? 'early-exit' : pularR2 ? 'pular R2' : 'rodar R2'}`
      );
      send('similarity', {
        value: Number(similarity.toFixed(3)),
        skipR2: pularR2,
        earlyExit,
      });
    } else if (mode === 'panel_full' && rascunhosOk.length < 2) {
      pularR2 = true; // só 1 ok → não tem o que cruzar
    }

    // ============ Early-exit: melhor rascunho vira a resposta final ============
    if (earlyExit && bestDraft) {
      send('phase', { phase: 'revisions', skipped: rascunhos.length, reason: 'convergence' });
      rascunhos.forEach((r) => {
        send('revision_done', {
          model: r.model,
          ms: 0,
          erro: r.erro ?? null,
          critica: '',
          resposta_revisada: r.erro ? '' : r.texto,
          texto_bruto: '',
          skipped: true,
        });
      });

      send('phase', { phase: 'synthesis' });
      send('synthesis_start', { model: bestDraft.model });
      send('synthesis_done', {
        model: bestDraft.model,
        ms: bestDraft.ms,
        erro: null,
        texto: bestDraft.texto,
        tokens_input: bestDraft.tokens_input,
        tokens_output: bestDraft.tokens_output,
        early_exit: true,
      });

      const msTotal = Date.now() - inicioTotal;
      const asstMsg = addMessage(conversation.id, 'assistant', bestDraft.texto);
      const revisoesFull = rascunhos.map((r) => ({
        model: r.model,
        label: r.label,
        provider: r.provider,
        ms: 0,
        erro: r.erro || null,
        critica: '',
        resposta_revisada: r.erro ? '' : r.texto,
        texto: '',
        skipped: true,
      }));
      savePanelRun(asstMsg.id, {
        drafts: rascunhos,
        revisions: revisoesFull,
        synthesis_text: bestDraft.texto,
        synthesis_model: bestDraft.model,
        error: null,
        ms_total: msTotal,
        mode: `${mode}+early_exit`,
      });
      touchConversation(conversation.id);

      send('done', {
        ms_total: msTotal,
        assistant_message_id: asstMsg.id,
        synthesis_error: null,
      });
      res.end();
      log(
        C.green,
        '✓',
        `${C.bold}/chat/stream${C.reset} early-exit em ${msTotal}ms (sim=${similarity.toFixed(2)})`
      );
      return;
    }

    // ============ Round 2: condicional ============
    let revisoesFull;
    let materialSintese;

    if (pularR2) {
      send('phase', {
        phase: 'revisions',
        skipped: rascunhos.length,
        reason: mode === 'panel_no_critique' ? 'mode' : 'convergence',
      });
      rascunhos.forEach((r) => {
        send('revision_done', {
          model: r.model,
          ms: 0,
          erro: r.erro ?? null,
          critica: '',
          resposta_revisada: r.erro ? '' : r.texto,
          texto_bruto: '',
          skipped: true,
        });
      });
      revisoesFull = rascunhos.map((r) => ({
        model: r.model,
        label: r.label,
        provider: r.provider,
        ms: 0,
        erro: r.erro || null,
        critica: '',
        resposta_revisada: r.erro ? '' : r.texto,
        texto: '',
        skipped: true,
      }));
      materialSintese = 'drafts';
    } else {
      send('phase', { phase: 'revisions', skipped: rascunhos.length - rascunhosOk.length });

      // Dedupe: se 2 drafts são muito similares, mostra só o representante aos
      // revisores. Cada revisor ainda revisa o próprio rascunho normalmente.
      const promptCritica = isCodeContext ? PROMPT_CRITICA_CODE : PROMPT_CRITICA;
      const revisoes = await Promise.all(
        rascunhosOk.map(async (meuRascunho) => {
          const id = meuRascunho.model;
          send('revision_start', { model: id });
          const outrasBruto = rascunhosOk.filter((r) => r.model !== id);
          const outrasDedup = dedupeDrafts(outrasBruto);
          const outras = outrasDedup
            .map((r) => `### ${r.label}\n${truncateDraft(r.texto)}`)
            .join('\n\n---\n\n');
          const userMsg = `Pergunta original:\n${prompt}\n\n### Sua resposta inicial (${meuRascunho.label})\n${truncateDraft(meuRascunho.texto)}\n\n---\n\nRespostas dos outros:\n\n${outras || '(nenhuma — os demais falharam)'}\n\nProduza agora sua crítica e sua resposta revisada.`;

          const r = await streamModelo({
            id,
            messages: [...effectivePriorHistory, { role: 'user', content: userMsg }],
            system: makeSystem(summaryPrefix, promptCritica, coderSuffix),
            etiqueta: 'revisão',
            parentSignal: abortCtrl.signal,
            maxOutputTokens: MAX_TOKENS_REVISION,
            onDelta: (delta) => send('revision_delta', { model: id, delta }),
          });
          const parsed = r.erro ? { critica: '', resposta_revisada: '' } : parseCriticaERevisao(r.texto);
          send('revision_done', {
            model: id,
            ms: r.ms,
            erro: r.erro ?? null,
            critica: parsed.critica,
            resposta_revisada: parsed.resposta_revisada,
            texto_bruto: r.texto,
          });
          return { ...r, ...parsed };
        })
      );

      revisoesFull = rascunhos.map((rasc) => {
        const rev = revisoes.find((r) => r.model === rasc.model);
        if (rev) return rev;
        return {
          model: rasc.model,
          label: rasc.label,
          provider: rasc.provider,
          ms: 0,
          erro: rasc.erro || 'rascunho falhou — pulou rodada 2',
          critica: '',
          resposta_revisada: '',
          texto: '',
        };
      });
      materialSintese = 'revisions';
    }

    if (clientGone) return;

    // ============ Round 3: síntese ============
    send('phase', { phase: 'synthesis' });

    let materialOk;
    let promptSinteseUsado;
    if (materialSintese === 'revisions') {
      materialOk = revisoesFull.filter(
        (r) => !r.erro && (r.resposta_revisada || r.texto)?.trim().length > 0
      );
      promptSinteseUsado = PROMPT_SINTESE;
    } else {
      materialOk = rascunhosOk;
      promptSinteseUsado = PROMPT_SINTESE_DRAFTS;
    }

    let sintese = null;
    let sinteseErroFinal = null;

    if (materialOk.length === 0) {
      sinteseErroFinal = 'Nenhum modelo produziu material — não há o que sintetizar.';
      send('synthesis_done', { model: null, erro: sinteseErroFinal, texto: '' });
    } else {
      // Dedupe também para a síntese: textos quase idênticos não adicionam sinal,
      // só inflam o input do agregador.
      const materialParaSintese = dedupeDrafts(
        materialOk.map((r) => ({
          ...r,
          texto:
            materialSintese === 'revisions' ? r.resposta_revisada || r.texto : r.texto,
        }))
      );
      const contextoSintese = materialParaSintese
        .map((r) => `### ${r.label}\n${truncateDraft(r.texto)}`)
        .join('\n\n---\n\n');

      const rotulo = materialSintese === 'revisions' ? 'Respostas revisadas do painel' : 'Rascunhos do painel';
      const messagesSintese = [
        ...effectivePriorHistory,
        {
          role: 'user',
          content: `Pergunta original:\n${prompt}\n\n${rotulo}:\n\n${contextoSintese}\n\nProduza a resposta final consolidada.`,
        },
      ];

      // Síntese não precisa do coderSuffix — os drafts/revisões já vieram formatados.
      const ordemAgregadores = [agregadorEfetivo, ...ids.filter((id) => id !== agregadorEfetivo)];
      const erros = [];
      for (const candidato of ordemAgregadores) {
        send('synthesis_start', { model: candidato });
        const r = await streamModelo({
          id: candidato,
          messages: messagesSintese,
          system: makeSystem(summaryPrefix, promptSinteseUsado),
          etiqueta: `síntese[${candidato}]`,
          parentSignal: abortCtrl.signal,
          maxOutputTokens: MAX_TOKENS_SYNTHESIS,
          onDelta: (delta) => send('synthesis_delta', { model: candidato, delta }),
        });
        if (!r.erro && r.texto?.trim().length > 0) {
          sintese = r;
          send('synthesis_done', {
            model: candidato,
            ms: r.ms,
            erro: null,
            texto: r.texto,
            tokens_input: r.tokens_input,
            tokens_output: r.tokens_output,
          });
          break;
        }
        erros.push(`${candidato}: ${r.erro || 'resposta vazia'}`);
        send('synthesis_fallback', { model: candidato, erro: r.erro || 'resposta vazia' });
        log(C.yellow, '↻', `agregador ${C.bold}${candidato}${C.reset} falhou, tentando próximo...`);
        if (clientGone) return;
      }
      if (!sintese) {
        sinteseErroFinal = `Todos os agregadores falharam. ${erros.join(' | ')}`;
        send('synthesis_done', { model: null, erro: sinteseErroFinal, texto: '' });
      }
    }

    const msTotal = Date.now() - inicioTotal;

    let assistantMessageId = null;
    if (sintese) {
      const asstMsg = addMessage(conversation.id, 'assistant', sintese.texto);
      assistantMessageId = asstMsg.id;
      savePanelRun(asstMsg.id, {
        drafts: rascunhos,
        revisions: revisoesFull,
        synthesis_text: sintese.texto,
        synthesis_model: sintese.model,
        error: null,
        ms_total: msTotal,
        mode,
      });
      touchConversation(conversation.id);
    } else {
      const asstMsg = addMessage(
        conversation.id,
        'assistant',
        `[síntese falhou] ${sinteseErroFinal ?? ''}`
      );
      assistantMessageId = asstMsg.id;
      savePanelRun(asstMsg.id, {
        drafts: rascunhos,
        revisions: revisoesFull,
        synthesis_text: null,
        synthesis_model: null,
        error: sinteseErroFinal,
        ms_total: msTotal,
        mode,
      });
      touchConversation(conversation.id);
    }

    send('done', {
      ms_total: msTotal,
      assistant_message_id: assistantMessageId,
      synthesis_error: sinteseErroFinal,
    });
    res.end();

    const falhas = [...rascunhos, ...revisoesFull].filter((r) => r.erro).length;
    const statusColor = falhas > 0 || sinteseErroFinal ? C.yellow : C.green;
    const statusIcon = falhas > 0 || sinteseErroFinal ? '⚠' : '✓';
    log(
      statusColor,
      statusIcon,
      `${C.bold}/chat/stream${C.reset} mode=${mode} em ${msTotal}ms${falhas > 0 ? ` (${falhas} falharam)` : ''}${sinteseErroFinal ? ' [síntese falhou]' : ''}`
    );
  } catch (err) {
    if (err && err.name === 'AbortError') {
      log(C.yellow, '⊘', `${C.bold}/chat/stream${C.reset} abortado pelo cliente`);
      if (!clientGone) {
        send('error', { error: 'aborted' });
        res.end();
      }
      return;
    }
    log(C.red, '✗', `${C.bold}/chat/stream${C.reset} erro inesperado: ${err.message}`);
    try {
      send('error', { error: err.message || String(err) });
      res.end();
    } catch {}
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`\n${C.bold}many-ais${C.reset} rodando em ${C.cyan}http://localhost:${port}${C.reset}`);
  console.log(`${C.dim}timeout por modelo: ${TIMEOUT_MS}ms · retries: ${MAX_RETRIES}${C.reset}`);
  console.log(`${C.dim}endpoints:${C.reset}`);
  console.log(`${C.dim}  GET    /models${C.reset}`);
  console.log(`${C.dim}  GET    /conversations${C.reset}`);
  console.log(`${C.dim}  GET    /conversations/:id${C.reset}`);
  console.log(`${C.dim}  DELETE /conversations/:id${C.reset}`);
  console.log(`${C.dim}  POST   /chat/stream  (SSE)${C.reset}\n`);
});

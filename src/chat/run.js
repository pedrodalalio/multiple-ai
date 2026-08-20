// run.js — orquestração de um turno: roteamento de modo, rodadas do painel,
// síntese e persistência. Todo caminho de saída grava exatamente um turno.
import {
  ADAPTIVE_PANEL_CODE,
  ADAPTIVE_PANEL_CODE_SIZE,
  MAX_TOKENS_DRAFT,
  MAX_TOKENS_DRAFT_CODE,
  MAX_TOKENS_REVISION,
  MAX_TOKENS_SYNTHESIS,
} from '../config.js';
import { classifyPrompt, decideAfterDrafts, dedupeDrafts, hasCodeSignals, isSelfContainedPrompt } from '../classify.js';
import { addMessage, createConversation, saveAssistantTurn } from '../db.js';
import { MODELS, defaultCoderModelId } from '../models.js';
import { streamModel } from '../lib/model-stream.js';
import { ensureSummary, loadWindowedMessages } from '../lib/context.js';
import { parseCriticaERevisao } from '../lib/parse.js';
import {
  PROMPT_CODER_SUFFIX,
  PROMPT_CRITICA,
  PROMPT_CRITICA_CODE,
  PROMPT_SINTESE,
  PROMPT_SINTESE_DRAFTS,
  formatBlocks,
  makeSystem,
} from '../lib/prompts.js';
import { C, log } from '../logger.js';

// ---------- helpers de turno ----------

/** Revisões "não rodadas": o rascunho vira a resposta revisada, sem crítica. */
function asSkippedRevisions(drafts) {
  return drafts.map((r) => ({
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
}

function emitSkippedRevisions(sse, drafts, { skipped, reason }) {
  sse.send('phase', { phase: 'revisions', skipped, reason });
  for (const r of drafts) {
    sse.send('revision_done', {
      model: r.model,
      ms: 0,
      erro: r.erro ?? null,
      critica: '',
      resposta_revisada: r.erro ? '' : r.texto,
      texto_bruto: '',
      skipped: true,
    });
  }
}

function draftDonePayload(r) {
  return {
    model: r.model,
    ms: r.ms,
    tokens_input: r.tokens_input,
    tokens_output: r.tokens_output,
    erro: r.erro ?? null,
    texto: r.texto,
  };
}

/**
 * Único ponto de saída: grava mensagem + painel numa transação, avisa o cliente
 * e fecha o SSE. Vale inclusive quando o cliente já foi embora — o turno tem que
 * ficar registrado, senão a mensagem do usuário fica órfã e o próximo pedido
 * manda dois `user` seguidos pro provider.
 */
function finishTurn(ctx, turn) {
  const ms_total = Date.now() - ctx.startedAt;
  const saved = saveAssistantTurn(ctx.conversation.id, { ...turn, ms_total });
  ctx.sse.send('done', {
    ms_total,
    assistant_message_id: saved.id,
    synthesis_error: turn.error ?? null,
  });
  ctx.sse.end();
  return { ...saved, ms_total };
}

function finishCancelled(ctx, { drafts = [], revisions = [], mode }) {
  log(C.yellow, '⊘', `${C.bold}/chat/stream${C.reset} cancelado — turno salvo como incompleto`);
  return finishTurn(ctx, {
    content: '[cancelado] a requisição foi interrompida antes da resposta final.',
    isError: true,
    drafts,
    revisions,
    synthesis_text: null,
    synthesis_model: null,
    error: 'cancelado pelo cliente',
    mode: mode ? `${mode}+cancelled` : 'cancelled',
  });
}

const wasAborted = (ctx, results = []) =>
  ctx.abortCtrl.signal.aborted || results.some((r) => r?.aborted);

// ---------- modo single_fast ----------

async function runSingleFast(ctx) {
  const { sse, ids, isCodeContext } = ctx;

  // Prefere o modelo "coder", mas só se o usuário o deixou no painel — antes
  // isto era incondicional e ignorava a seleção da UI por completo.
  const coderId = defaultCoderModelId();
  const onlyId = coderId && ids.includes(coderId) ? coderId : ids[0];
  const meta = MODELS[onlyId];

  sse.send('meta', {
    conversation_id: ctx.conversation.id,
    user_message_id: ctx.userMessage.id,
    panel: [{ id: onlyId, label: meta.label, provider: meta.provider }],
    aggregator: onlyId,
    mode: ctx.mode,
    classified: ctx.classified,
  });

  sse.send('phase', { phase: 'drafts' });
  sse.send('draft_start', { model: onlyId });

  const r = await streamModel({
    id: onlyId,
    messages: ctx.r1Messages,
    system: makeSystem(ctx.summaryPrefix, ctx.coderSuffix),
    etiqueta: 'único',
    parentSignal: ctx.abortCtrl.signal,
    maxOutputTokens: isCodeContext ? MAX_TOKENS_DRAFT_CODE : MAX_TOKENS_DRAFT,
    onDelta: (delta) => sse.send('draft_delta', { model: onlyId, delta }),
    onRestart: () => sse.send('draft_reset', { model: onlyId }),
  });

  if (wasAborted(ctx, [r])) return finishCancelled(ctx, { drafts: [r], mode: ctx.mode });

  sse.send('draft_done', draftDonePayload(r));

  // O rascunho é a resposta final — reflete como síntese pra UI mostrar no card.
  sse.send('phase', { phase: 'synthesis' });
  sse.send('synthesis_start', { model: onlyId });
  if (r.erro) {
    sse.send('synthesis_done', { model: null, erro: r.erro, texto: '' });
  } else {
    sse.send('synthesis_done', {
      model: onlyId,
      ms: r.ms,
      erro: null,
      texto: r.texto,
      tokens_input: r.tokens_input,
      tokens_output: r.tokens_output,
    });
  }

  const out = finishTurn(ctx, {
    content: r.erro ? `[erro] ${r.erro}` : r.texto,
    isError: Boolean(r.erro),
    drafts: [r],
    revisions: [],
    synthesis_text: r.erro ? null : r.texto,
    synthesis_model: r.erro ? null : onlyId,
    error: r.erro ?? null,
    mode: ctx.mode,
  });

  log(
    r.erro ? C.yellow : C.green,
    r.erro ? '⚠' : '✓',
    `${C.bold}/chat/stream${C.reset} mode=${ctx.mode} concluído em ${out.ms_total}ms`
  );
}

// ---------- rodada 1 ----------

async function runDrafts(ctx) {
  const { sse, ids } = ctx;
  sse.send('phase', { phase: 'drafts' });
  for (const id of ids) sse.send('draft_start', { model: id });

  const system = makeSystem(ctx.summaryPrefix, ctx.coderSuffix);
  const cap = ctx.isCodeContext ? MAX_TOKENS_DRAFT_CODE : MAX_TOKENS_DRAFT;

  return Promise.all(
    ids.map(async (id) => {
      const r = await streamModel({
        id,
        messages: ctx.r1Messages,
        system,
        etiqueta: 'rascunho',
        parentSignal: ctx.abortCtrl.signal,
        maxOutputTokens: cap,
        onDelta: (delta) => sse.send('draft_delta', { model: id, delta }),
        onRestart: () => sse.send('draft_reset', { model: id }),
      });
      if (!r.aborted) sse.send('draft_done', draftDonePayload(r));
      return r;
    })
  );
}

// ---------- rodada 2 ----------

async function runRevisions(ctx, draftsOk) {
  const { sse } = ctx;
  const promptCritica = ctx.isCodeContext ? PROMPT_CRITICA_CODE : PROMPT_CRITICA;
  const system = makeSystem(ctx.summaryPrefix, promptCritica, ctx.coderSuffix);

  return Promise.all(
    draftsOk.map(async (meu) => {
      const id = meu.model;
      sse.send('revision_start', { model: id });

      // Dedupe: se 2 rascunhos são quase iguais, mostra só o representante aos
      // revisores. Cada revisor continua revisando o próprio rascunho.
      const outras = dedupeDrafts(draftsOk.filter((r) => r.model !== id));
      const blocoOutras = outras.length
        ? formatBlocks(outras)
        : '(nenhuma — os demais falharam)';

      const userMsg = [
        `Pergunta original:\n${ctx.prompt}`,
        `Sua resposta inicial:\n${formatBlocks([meu])}`,
        `Respostas dos outros:\n\n${blocoOutras}`,
        'Produza agora sua crítica e sua resposta revisada.',
      ].join('\n\n---\n\n');

      const r = await streamModel({
        id,
        messages: [...ctx.priorHistory, { role: 'user', content: userMsg }],
        system,
        etiqueta: 'revisão',
        parentSignal: ctx.abortCtrl.signal,
        maxOutputTokens: MAX_TOKENS_REVISION,
        onDelta: (delta) => sse.send('revision_delta', { model: id, delta }),
        onRestart: () => sse.send('revision_reset', { model: id }),
      });

      const parsed = r.erro ? { critica: '', resposta_revisada: '' } : parseCriticaERevisao(r.texto);
      // Modelo respondeu só com crítica: mantém o rascunho dele como resposta
      // em vez de descartar o turno inteiro.
      const resposta_revisada = parsed.resposta_revisada || (r.erro ? '' : meu.texto);

      if (!r.aborted) {
        sse.send('revision_done', {
          model: id,
          ms: r.ms,
          erro: r.erro ?? null,
          critica: parsed.critica,
          resposta_revisada,
          texto_bruto: r.texto,
        });
      }
      return { ...r, critica: parsed.critica, resposta_revisada };
    })
  );
}

// ---------- rodada 3 ----------

async function runSynthesis(ctx, { material, kind }) {
  const { sse } = ctx;
  sse.send('phase', { phase: 'synthesis' });

  if (material.length === 0) {
    const erro = 'Nenhum modelo produziu material — não há o que sintetizar.';
    sse.send('synthesis_done', { model: null, erro, texto: '' });
    return { sintese: null, erro };
  }

  // Dedupe também aqui: textos quase idênticos não adicionam sinal, só inflam
  // o input do agregador.
  const unicos = dedupeDrafts(material);
  const rotulo = kind === 'revisions' ? 'Respostas revisadas do painel' : 'Rascunhos do painel';
  const messages = [
    ...ctx.priorHistory,
    {
      role: 'user',
      content: `Pergunta original:\n${ctx.prompt}\n\n${rotulo}:\n\n${formatBlocks(unicos)}\n\nProduza a resposta final consolidada.`,
    },
  ];
  // A síntese não precisa do coderSuffix — o material já veio formatado.
  const system = makeSystem(
    ctx.summaryPrefix,
    kind === 'revisions' ? PROMPT_SINTESE : PROMPT_SINTESE_DRAFTS
  );

  const candidatos = [ctx.aggregator, ...ctx.ids.filter((id) => id !== ctx.aggregator)];
  const erros = [];

  for (const candidato of candidatos) {
    sse.send('synthesis_start', { model: candidato });
    const r = await streamModel({
      id: candidato,
      messages,
      system,
      etiqueta: `síntese[${candidato}]`,
      parentSignal: ctx.abortCtrl.signal,
      maxOutputTokens: MAX_TOKENS_SYNTHESIS,
      onDelta: (delta) => sse.send('synthesis_delta', { model: candidato, delta }),
      onRestart: () => sse.send('synthesis_reset', { model: candidato }),
    });

    if (r.aborted) return { sintese: null, erro: null, aborted: true };

    if (!r.erro && r.texto.trim()) {
      sse.send('synthesis_done', {
        model: candidato,
        ms: r.ms,
        erro: null,
        texto: r.texto,
        tokens_input: r.tokens_input,
        tokens_output: r.tokens_output,
      });
      return { sintese: r, erro: null };
    }

    erros.push(`${candidato}: ${r.erro || 'resposta vazia'}`);
    sse.send('synthesis_fallback', { model: candidato, erro: r.erro || 'resposta vazia' });
    log(C.yellow, '↻', `agregador ${C.bold}${candidato}${C.reset} falhou, tentando próximo...`);
  }

  const erro = `Todos os agregadores falharam. ${erros.join(' | ')}`;
  sse.send('synthesis_done', { model: null, erro, texto: '' });
  return { sintese: null, erro };
}

// ---------- modo painel ----------

async function runPanel(ctx) {
  const { sse, ids } = ctx;

  sse.send('meta', {
    conversation_id: ctx.conversation.id,
    user_message_id: ctx.userMessage.id,
    panel: ids.map((id) => ({ id, label: MODELS[id].label, provider: MODELS[id].provider })),
    aggregator: ctx.aggregator,
    mode: ctx.mode,
    classified: ctx.classified,
  });

  const drafts = await runDrafts(ctx);
  if (wasAborted(ctx, drafts)) return finishCancelled(ctx, { drafts, mode: ctx.mode });

  const draftsOk = drafts.filter((r) => !r.erro && r.texto.trim().length > 0);

  // panel_no_critique  → sempre pula R2.
  // panel_full         → similaridade decide: pular R2, early-exit, ou rodar R2.
  let skipR2 = ctx.mode === 'panel_no_critique';
  let earlyExit = false;
  let bestDraft = null;
  let similarity = null;

  if (ctx.mode === 'panel_full') {
    if (draftsOk.length >= 2) {
      const decision = decideAfterDrafts(draftsOk);
      similarity = decision.similarity;
      skipR2 = decision.skip;
      earlyExit = decision.earlyExit;
      bestDraft = draftsOk[decision.bestIndex];
      log(
        C.cyan,
        '∼',
        `similaridade=${similarity.toFixed(2)} → ${earlyExit ? 'early-exit' : skipR2 ? 'pular R2' : 'rodar R2'}`
      );
      sse.send('similarity', { value: Number(similarity.toFixed(3)), skipR2, earlyExit });
    } else {
      skipR2 = true; // só 1 rascunho ok → não tem o que cruzar
    }
  }

  // ---- Early-exit: o melhor rascunho já é a resposta final ----
  if (earlyExit && bestDraft) {
    emitSkippedRevisions(sse, drafts, { skipped: drafts.length, reason: 'convergence' });
    sse.send('phase', { phase: 'synthesis' });
    sse.send('synthesis_start', { model: bestDraft.model });
    sse.send('synthesis_done', {
      model: bestDraft.model,
      ms: bestDraft.ms,
      erro: null,
      texto: bestDraft.texto,
      tokens_input: bestDraft.tokens_input,
      tokens_output: bestDraft.tokens_output,
      early_exit: true,
    });

    const out = finishTurn(ctx, {
      content: bestDraft.texto,
      isError: false,
      drafts,
      revisions: asSkippedRevisions(drafts),
      synthesis_text: bestDraft.texto,
      synthesis_model: bestDraft.model,
      error: null,
      mode: `${ctx.mode}+early_exit`,
    });
    log(
      C.green,
      '✓',
      `${C.bold}/chat/stream${C.reset} early-exit em ${out.ms_total}ms (sim=${similarity.toFixed(2)})`
    );
    return;
  }

  // ---- Rodada 2 (condicional) ----
  let revisions;
  let kind;

  if (skipR2) {
    emitSkippedRevisions(sse, drafts, {
      skipped: drafts.length,
      reason: ctx.mode === 'panel_no_critique' ? 'mode' : 'convergence',
    });
    revisions = asSkippedRevisions(drafts);
    kind = 'drafts';
  } else {
    sse.send('phase', { phase: 'revisions', skipped: drafts.length - draftsOk.length });
    const revised = await runRevisions(ctx, draftsOk);
    if (wasAborted(ctx, revised)) {
      return finishCancelled(ctx, { drafts, revisions: revised, mode: ctx.mode });
    }
    revisions = drafts.map((d) => {
      const rev = revised.find((r) => r.model === d.model);
      if (rev) return rev;
      return {
        model: d.model,
        label: d.label,
        provider: d.provider,
        ms: 0,
        erro: d.erro || 'rascunho falhou — pulou rodada 2',
        critica: '',
        resposta_revisada: '',
        texto: '',
      };
    });
    kind = 'revisions';
  }

  // ---- Rodada 3: síntese ----
  const material = (kind === 'revisions'
    ? revisions.filter((r) => !r.erro && (r.resposta_revisada || r.texto || '').trim())
    : draftsOk
  ).map((r) => ({
    ...r,
    texto: kind === 'revisions' ? r.resposta_revisada || r.texto : r.texto,
  }));

  const { sintese, erro, aborted } = await runSynthesis(ctx, { material, kind });
  if (aborted || ctx.abortCtrl.signal.aborted) {
    return finishCancelled(ctx, { drafts, revisions, mode: ctx.mode });
  }

  const out = finishTurn(ctx, {
    content: sintese ? sintese.texto : `[síntese falhou] ${erro ?? ''}`,
    isError: !sintese,
    drafts,
    revisions,
    synthesis_text: sintese?.texto ?? null,
    synthesis_model: sintese?.model ?? null,
    error: sintese ? null : erro,
    mode: ctx.mode,
  });

  const falhas = [...drafts, ...revisions].filter((r) => r.erro).length;
  const ok = falhas === 0 && sintese;
  log(
    ok ? C.green : C.yellow,
    ok ? '✓' : '⚠',
    `${C.bold}/chat/stream${C.reset} mode=${ctx.mode} em ${out.ms_total}ms` +
      `${falhas > 0 ? ` (${falhas} falharam)` : ''}${sintese ? '' : ' [síntese falhou]'}`
  );
}

// ---------- entrada ----------

/**
 * Monta o contexto do turno e despacha pro modo escolhido.
 * `params` já vem validado pela rota.
 */
export async function runChatTurn({ sse, abortCtrl, params }) {
  const { prompt, conversationId, modelIds, aggregator, requestedMode } = params;

  let conversation;
  if (conversationId) {
    conversation = params.conversation;
  } else {
    const title = prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
    conversation = createConversation({ title, panel: modelIds, aggregator });
  }

  const userMessage = addMessage(conversation.id, 'user', prompt);

  const classified = classifyPrompt(prompt);
  const mode = requestedMode === 'auto' ? classified : requestedMode;
  const isCodeContext = classified === 'single_fast' || hasCodeSignals(prompt);
  const coderSuffix = isCodeContext ? PROMPT_CODER_SUFFIX : null;

  // Painel adaptativo: em contexto de código, 2 modelos costumam bastar.
  let ids = modelIds;
  let panelTrimmed = false;
  if (
    ADAPTIVE_PANEL_CODE &&
    isCodeContext &&
    (mode === 'panel_full' || mode === 'panel_no_critique') &&
    modelIds.length > ADAPTIVE_PANEL_CODE_SIZE
  ) {
    const coderId = defaultCoderModelId();
    const coderFirst =
      coderId && modelIds.includes(coderId)
        ? [coderId, ...modelIds.filter((x) => x !== coderId)]
        : modelIds;
    ids = coderFirst.slice(0, ADAPTIVE_PANEL_CODE_SIZE);
    panelTrimmed = true;
  }
  const effectiveAggregator = ids.includes(aggregator) ? aggregator : ids[0];

  // Contexto: janela curta + summary do que ficou pra trás.
  const summary = await ensureSummary(conversation.id, abortCtrl.signal).catch(() => null);
  const windowed = loadWindowedMessages(conversation.id);
  const summaryPrefix = summary ? `Resumo da conversa anterior:\n${summary}` : '';

  // Prompt auto-contido (código fenced, sem referência ao histórico): manda só a
  // mensagem atual. Corta input significativo.
  const selfContained = isSelfContainedPrompt(prompt);
  const current = windowed[windowed.length - 1] ?? { role: 'user', content: prompt };

  const ctx = {
    sse,
    abortCtrl,
    conversation,
    userMessage,
    prompt,
    ids,
    aggregator: effectiveAggregator,
    mode,
    classified,
    isCodeContext,
    coderSuffix,
    summaryPrefix,
    r1Messages: selfContained ? [current] : windowed,
    priorHistory: selfContained ? [] : windowed.slice(0, -1),
    startedAt: Date.now(),
  };

  const flags = [
    isCodeContext && '[código]',
    summary && '[com sumário]',
    selfContained && '[self-contained]',
    panelTrimmed && `[painel ${modelIds.length}→${ids.length}]`,
  ]
    .filter(Boolean)
    .join(' ');
  const autoNote = classified !== mode ? ` (auto=${classified}, forçado=${requestedMode})` : '';
  log(
    C.magenta,
    '◆',
    `${C.bold}/chat/stream${C.reset} conv=${conversation.id} mode=${C.bold}${mode}${C.reset}${autoNote} ${flags}`
  );
  const preview = prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt;
  log(C.magenta, '◆', `prompt: ${C.dim}"${preview}"${C.reset}`);

  try {
    if (mode === 'single_fast') return await runSingleFast(ctx);
    return await runPanel(ctx);
  } catch (err) {
    log(C.red, '✗', `${C.bold}/chat/stream${C.reset} erro inesperado: ${err?.message || err}`);
    sse.send('error', { error: err?.message || String(err) });
    finishTurn(ctx, {
      content: `[erro] ${err?.message || err}`,
      isError: true,
      drafts: [],
      revisions: [],
      synthesis_text: null,
      synthesis_model: null,
      error: err?.message || String(err),
      mode: ctx.mode,
    });
  }
}

// model-stream.js — chamada streamada a um modelo, com retry e timeouts.
import { streamText } from 'ai';
import { MODELS, getModelInstance, isModelAvailable, PROVIDER_ENV_KEYS } from '../models.js';
import { MAX_RETRIES, MODEL_HARD_TIMEOUT_MS, MODEL_IDLE_TIMEOUT_MS } from '../config.js';
import { C, log } from '../logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_MESSAGE =
  /rate.?limit|timeout|timed out|econnreset|etimedout|enotfound|eai_again|fetch failed|socket hang up|temporarily|overloaded|service unavailable/i;

export function isTransientError(err) {
  if (!err) return false;
  const status = err.statusCode ?? err.status ?? err.response?.status;
  if (status && RETRYABLE_STATUS.has(status)) return true;
  return RETRYABLE_MESSAGE.test(err.message || String(err));
}

/**
 * Resultado — sempre resolve, nunca rejeita. Contrato único para todos os callers:
 *   { model, label, provider, ms, texto, tokens_input, tokens_output, erro, aborted }
 * `erro` é null em caso de sucesso; `aborted` é true só quando o cliente desistiu.
 */
function result(id, extra) {
  const meta = MODELS[id];
  return {
    model: id,
    label: meta?.label ?? id,
    provider: meta?.provider ?? 'unknown',
    ms: 0,
    texto: '',
    tokens_input: null,
    tokens_output: null,
    erro: null,
    aborted: false,
    ...extra,
  };
}

/**
 * Chamada streamada com retry em erros transientes.
 *
 * Timeouts:
 *  - idle: reinicia a cada chunk recebido, então um stream que está produzindo
 *    tokens nunca é morto por demorar no total;
 *  - hard: teto absoluto de uma tentativa.
 * Ambos contam como transientes e são retentados. Abort do cliente não é.
 *
 * `onRestart` é chamado quando um retry vai reemitir texto que o caller já
 * recebeu via `onDelta` — quem consome usa isso pra limpar o buffer parcial.
 */
export async function streamModel({
  id,
  messages,
  system,
  etiqueta = '',
  onDelta,
  onRestart,
  parentSignal,
  maxOutputTokens,
}) {
  const meta = MODELS[id];
  if (!meta) return result(id, { erro: `Modelo desconhecido: ${id}` });
  if (!isModelAvailable(id)) {
    return result(id, {
      erro: `Provider "${meta.provider}" sem API key (defina ${PROVIDER_ENV_KEYS[meta.provider]})`,
    });
  }

  const tag = etiqueta ? `[${etiqueta}] ` : '';
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (parentSignal?.aborted) return result(id, { aborted: true, erro: 'cancelado pelo cliente' });

    const started = Date.now();
    const ctrl = new AbortController();
    // 'idle' | 'hard' | 'parent' — diferencia o motivo do abort local, já que a
    // exceção que sobe do SDK é indistinguível entre eles.
    let abortReason = null;
    let idleTimer = null;
    let emittedAny = false;

    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        abortReason = 'idle';
        ctrl.abort(new Error(`sem chunks por ${MODEL_IDLE_TIMEOUT_MS}ms`));
      }, MODEL_IDLE_TIMEOUT_MS);
    };
    const hardTimer = setTimeout(() => {
      abortReason = 'hard';
      ctrl.abort(new Error(`tentativa passou de ${MODEL_HARD_TIMEOUT_MS}ms`));
    }, Math.max(MODEL_HARD_TIMEOUT_MS, MODEL_IDLE_TIMEOUT_MS));
    const onParentAbort = () => {
      abortReason = 'parent';
      ctrl.abort(parentSignal.reason);
    };
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });

    log(
      C.cyan,
      '⟳',
      `${tag}${C.bold}${id}${C.reset} ${C.dim}iniciando${attempt > 0 ? ` (retry ${attempt})` : ''}...${C.reset}`
    );

    try {
      bumpIdle();
      let streamErr = null;
      const stream = streamText({
        model: getModelInstance(id),
        system,
        messages,
        maxOutputTokens,
        abortSignal: ctrl.signal,
        onError: ({ error }) => {
          streamErr = error;
        },
      });

      let texto = '';
      for await (const delta of stream.textStream) {
        bumpIdle();
        texto += delta;
        if (delta) emittedAny = true;
        onDelta?.(delta);
      }
      if (streamErr) throw streamErr;

      const usage = await stream.usage.catch(() => null);
      const ms = Date.now() - started;
      const tokens = usage
        ? `${C.dim}(${usage.inputTokens ?? '?'} in / ${usage.outputTokens ?? '?'} out)${C.reset}`
        : '';
      log(C.green, '✓', `${tag}${C.bold}${id}${C.reset} ${ms}ms ${tokens}`);

      return result(id, {
        ms,
        texto,
        tokens_input: usage?.inputTokens ?? null,
        tokens_output: usage?.outputTokens ?? null,
      });
    } catch (err) {
      const ms = Date.now() - started;
      lastErr = err;

      if (abortReason === 'parent' || parentSignal?.aborted) {
        log(C.yellow, '⊘', `${tag}${C.bold}${id}${C.reset} ${ms}ms cancelado pelo cliente`);
        return result(id, { ms, aborted: true, erro: 'cancelado pelo cliente' });
      }

      const timedOut = abortReason === 'idle' || abortReason === 'hard';
      const message = timedOut
        ? `timeout (${abortReason}): ${err instanceof Error ? err.message : String(err)}`
        : err instanceof Error
          ? err.message
          : String(err);

      // Timeout local conta como transiente — antes ele caía no check de
      // AbortError e o MODEL_TIMEOUT_MS nunca chegava a retentar.
      if ((timedOut || isTransientError(err)) && attempt < MAX_RETRIES) {
        const backoff = 400 * 2 ** attempt + Math.floor(Math.random() * 200);
        log(
          C.yellow,
          '↻',
          `${tag}${C.bold}${id}${C.reset} ${ms}ms falhou transiente (${message}), retry em ${backoff}ms`
        );
        // O cliente já recebeu texto parcial desta tentativa; avisa pra descartar
        // antes que o retry mande a resposta inteira de novo.
        if (emittedAny) onRestart?.(attempt + 1);
        await sleep(backoff);
        continue;
      }

      log(C.red, '✗', `${tag}${C.bold}${id}${C.reset} ${ms}ms ${C.red}${message}${C.reset}`);
      return result(id, { ms, erro: message });
    } finally {
      clearTimeout(hardTimer);
      clearTimeout(idleTimer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  }

  return result(id, { erro: lastErr ? lastErr.message : 'erro desconhecido' });
}

/** Coleta o texto completo sem streamar pro cliente (sumarização, jobs internos). */
export async function collectModel(options) {
  return streamModel({ ...options, onDelta: undefined, onRestart: undefined });
}

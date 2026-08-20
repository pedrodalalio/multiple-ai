// classify.js — heurísticas para roteamento de modo e detecção de convergência.
import {
  SIMILARITY_DEDUP,
  SIMILARITY_EARLY_EXIT,
  SIMILARITY_SKIP_CRITIQUE,
} from './config.js';

// Detecta sinais de código no prompt sem precisar de LLM.
const CODE_FENCE = /```/;
const CODE_INLINE_HEAVY = /`[^`\n]{2,}`/g;
const CODE_TOKENS = /\b(function|const|let|var|return|class|interface|type|def|import|export|require|async|await|throw|catch|public|private|static|enum)\b/;
const CODE_PUNCT = /=>|::|->|\$\{|\b\w+\(\w*\)/;
const ERROR_HINTS = /\b(stacktrace|traceback|exception|nullpointer|segfault|undefined is not|cannot read|cannot find|module not found|syntax\s*error|type\s*error|reference\s*error|runtime\s*error|compile\s*error|error\s*:\s*[A-Z])/i;
const TECH_KEYWORDS = /\b(javascript|typescript|python|node\.?js|deno|bun|react|vue|svelte|angular|next\.?js|express|fastify|django|flask|rails|laravel|spring|rust|golang|kotlin|swift|sql|postgres|mysql|sqlite|mongodb|redis|docker|kubernetes|k8s|nginx|webpack|vite|esbuild|npm|pnpm|yarn|pip|cargo|gradle|maven|git\b|github|gitlab|api|endpoint|http|rest|graphql|websocket|jwt|oauth|regex|regexp|json|yaml|toml|csv|html|css|tailwind|tsx|jsx|sass|scss)\b/i;

// Referências que apontam para contexto anterior — quando presentes, history importa.
const CONTEXT_REFS = /\b(isso|isto|aquilo|esse|essa|aquele|aquela|acima|anterior|continua|continuar|continue|this|that|above|previous|earlier|before)\b/i;

// Sinais de pergunta opinativa / arquitetural onde o painel agrega valor.
const DELIBERATION_HINTS = /\b(qual\s+(é|eh)?\s*(o|a)?\s*melhor|melhor\s+(forma|maneira|abordagem|jeito|caminho|estrat[eé]gia)|trade[\s-]?off|compar[ae]r?|opini[aã]o|prefer[eê]ncia|escolher|deveria|deveriam|recomenda|sugere|sugest[aã]o|arquitetur|design\s+pattern|qual\s+usar)/i;
const REVIEW_HINTS = /\b(revis[ae]r?|review|melhor[ae]r?|otimi[zs]ar|refator[ae]r?|bug|problema|porque\s+n[aã]o|por\s+que\s+n[aã]o|n[aã]o\s+funciona|quebr[ao]u|achei?\s+algo\s+errado)/i;

const SHORT_THRESHOLD = 140;
const SELF_CONTAINED_MIN_CHARS = 200;

/**
 * Verifica se o prompt contém sinais de código (regex barato, sem LLM).
 * Fonte única — `classifyPrompt` também usa esta função.
 */
export function hasCodeSignals(prompt) {
  if (typeof prompt !== 'string' || !prompt) return false;
  const inlineCount = (prompt.match(CODE_INLINE_HEAVY) || []).length;
  return (
    CODE_FENCE.test(prompt) ||
    inlineCount >= 2 ||
    CODE_TOKENS.test(prompt) ||
    CODE_PUNCT.test(prompt) ||
    ERROR_HINTS.test(prompt) ||
    TECH_KEYWORDS.test(prompt)
  );
}

/**
 * Prompt "auto-contido" = traz código com fence, é razoavelmente longo e
 * não tem pronome/referência apontando para turno anterior. Quando true,
 * podemos pular o history pra economizar input.
 *
 * O check de CONTEXT_REFS ignora o conteúdo dentro das fences pra não confundir
 * keywords de linguagem (ex.: `continue` em JS) com referência a turno anterior.
 */
export function isSelfContainedPrompt(prompt) {
  if (typeof prompt !== 'string') return false;
  const trimmed = prompt.trim();
  if (!CODE_FENCE.test(trimmed)) return false;
  if (trimmed.length < SELF_CONTAINED_MIN_CHARS) return false;
  const proseOnly = trimmed.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  return !CONTEXT_REFS.test(proseOnly);
}

/**
 * Classifica o prompt em um modo de operação.
 *  - single_fast:        1 modelo só (código objetivo, perguntas factuais sobre tecnologia)
 *  - panel_no_critique:  N rascunhos paralelos -> síntese direto (sem rodada de crítica)
 *  - panel_full:         fluxo completo, com crítica e revisão (ambíguo / opinativo / review)
 */
export function classifyPrompt(prompt) {
  if (typeof prompt !== 'string') return 'panel_full';
  const trimmed = prompt.trim();
  if (!trimmed) return 'panel_full';

  const code = hasCodeSignals(trimmed);
  const isDeliberation = DELIBERATION_HINTS.test(trimmed);
  const isReview = REVIEW_HINTS.test(trimmed);
  const isShort = trimmed.length < SHORT_THRESHOLD;

  // Código + pedido de revisão / decisão arquitetural -> painel vale o custo.
  if (code && (isReview || isDeliberation)) return 'panel_full';
  // Código objetivo (snippet, erro, "como faço X em Y") -> 1 modelo basta.
  if (code) return 'single_fast';
  // Pergunta puramente opinativa sem código -> painel completo.
  if (isDeliberation) return 'panel_full';
  // Curta e factual -> painel sem crítica.
  if (isShort) return 'panel_no_critique';
  return 'panel_full';
}

// ----------------------------------------------------------------------------
// Similaridade entre rascunhos — usado para decidir pular R2 / early-exit.
// Jaccard sobre uni/bi/tri-gramas de palavras (lowercase, sem acento/pontuação).

// Escapes explícitos: os combining marks literais são invisíveis no editor e
// quebram em qualquer re-encoding do arquivo.
const COMBINING_MARKS = /[\u0300-\u036f]/g;

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(tokens, n) {
  const set = new Set();
  if (tokens.length < n) {
    for (const t of tokens) set.add(t);
    return set;
  }
  for (let i = 0; i + n <= tokens.length; i++) {
    set.add(tokens.slice(i, i + n).join(' '));
  }
  return set;
}

/**
 * Pré-computa os conjuntos de n-gramas de um texto. Comparar N textos entre si
 * continua O(N²) em pares, mas a tokenização acontece uma vez por texto.
 */
export function signature(text) {
  const tokens = tokenize(text);
  return { g1: ngrams(tokens, 1), g2: ngrams(tokens, 2), g3: ngrams(tokens, 3) };
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Mix uni/bi/tri-gramas. Unigramas dominam porque vocabulário compartilhado é
// o sinal mais forte de "modelos falando da mesma coisa". N-gramas maiores
// servem como bônus de convergência estrutural.
export function similarityFromSignatures(a, b) {
  return 0.55 * jaccard(a.g1, b.g1) + 0.3 * jaccard(a.g2, b.g2) + 0.15 * jaccard(a.g3, b.g3);
}

export function mixedSimilarity(textA, textB) {
  return similarityFromSignatures(signature(textA), signature(textB));
}

/**
 * Similaridade média par-a-par entre os textos. 1.0 = idênticos, 0.0 = nada em comum.
 */
export function avgSimilarity(texts) {
  const clean = texts.map((t) => String(t || '').trim()).filter(Boolean);
  if (clean.length < 2) return 1;
  const sigs = clean.map(signature);
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      sum += similarityFromSignatures(sigs[i], sigs[j]);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : sum / pairs;
}

export { SIMILARITY_SKIP_CRITIQUE, SIMILARITY_EARLY_EXIT, SIMILARITY_DEDUP };

/**
 * Agrupa drafts altamente similares e devolve apenas um representante por grupo
 * (o mais longo). Usado pra encurtar o input das rodadas de crítica/síntese
 * quando 2+ modelos convergem mas não o bastante pra early-exit.
 */
export function dedupeDrafts(drafts, threshold = SIMILARITY_DEDUP) {
  if (!Array.isArray(drafts) || drafts.length <= 1) return drafts;
  const sorted = [...drafts].sort((a, b) => (b.texto?.length || 0) - (a.texto?.length || 0));

  const kept = [];
  const keptSigs = [];
  for (const d of sorted) {
    const sig = signature(d.texto || '');
    const dup = keptSigs.some((k) => similarityFromSignatures(k, sig) >= threshold);
    if (!dup) {
      kept.push(d);
      keptSigs.push(sig);
    }
  }
  return kept;
}

/**
 * Decide se vale rodar R2 dado os rascunhos da R1.
 * Retorna { skip, earlyExit, similarity, bestIndex }.
 */
export function decideAfterDrafts(drafts) {
  const texts = drafts.map((d) => d.texto || '');
  const similarity = avgSimilarity(texts);
  let bestIndex = 0;
  let bestLen = -1;
  for (let i = 0; i < drafts.length; i++) {
    const len = (drafts[i].texto || '').length;
    if (len > bestLen) {
      bestLen = len;
      bestIndex = i;
    }
  }
  return {
    similarity,
    skip: similarity >= SIMILARITY_SKIP_CRITIQUE,
    earlyExit: similarity >= SIMILARITY_EARLY_EXIT && drafts.length >= 2,
    bestIndex,
  };
}

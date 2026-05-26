// classify.js — heurísticas para roteamento de modo e detecção de convergência.

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

/**
 * Verifica se o prompt contém sinais de código (regex barato, sem LLM).
 */
export function hasCodeSignals(prompt) {
  if (typeof prompt !== 'string' || !prompt) return false;
  const lower = prompt.toLowerCase();
  const inlineCount = (prompt.match(CODE_INLINE_HEAVY) || []).length;
  return (
    CODE_FENCE.test(prompt) ||
    inlineCount >= 2 ||
    CODE_TOKENS.test(prompt) ||
    CODE_PUNCT.test(prompt) ||
    ERROR_HINTS.test(prompt) ||
    TECH_KEYWORDS.test(lower)
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
  if (trimmed.length < 200) return false;
  const proseOnly = trimmed.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  if (CONTEXT_REFS.test(proseOnly)) return false;
  return true;
}

/**
 * Classifica o prompt em um modo de operação.
 *  - single_fast:        1 modelo só (foco em código simples, perguntas factuais sobre tecnologia)
 *  - panel_no_critique:  N rascunhos paralelos -> síntese direto (sem rodada de crítica)
 *  - panel_full:         fluxo completo, com crítica e revisão (ambíguo / opinativo / review)
 */
export function classifyPrompt(prompt) {
  if (typeof prompt !== 'string') return 'panel_full';
  const trimmed = prompt.trim();
  if (!trimmed) return 'panel_full';

  const lower = trimmed.toLowerCase();
  const len = trimmed.length;

  const hasCodeFence = CODE_FENCE.test(trimmed);
  const inlineCount = (trimmed.match(CODE_INLINE_HEAVY) || []).length;
  const hasCodeSignals =
    hasCodeFence ||
    inlineCount >= 2 ||
    CODE_TOKENS.test(trimmed) ||
    CODE_PUNCT.test(trimmed) ||
    ERROR_HINTS.test(trimmed) ||
    TECH_KEYWORDS.test(lower);

  const isDeliberation = DELIBERATION_HINTS.test(lower);
  const isReview = REVIEW_HINTS.test(lower);
  const isShort = len < SHORT_THRESHOLD;

  // Código + pedido de revisão / decisão arquitetural -> painel vale o custo
  if (hasCodeSignals && (isReview || isDeliberation)) return 'panel_full';

  // Código objetivo (snippet, erro, "como faço X em Y") -> 1 modelo basta
  if (hasCodeSignals) return 'single_fast';

  // Pergunta puramente opinativa sem código -> painel completo
  if (isDeliberation) return 'panel_full';

  // Curta e factual -> painel sem crítica
  if (isShort) return 'panel_no_critique';

  // Default: painel completo
  return 'panel_full';
}

// ----------------------------------------------------------------------------
// Similaridade entre rascunhos — usado para decidir pular R2 / early-exit.
// Jaccard sobre tri-gramas de palavras (lowercase, sem pontuação).

function tokenize(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function ngrams(tokens, n) {
  const set = new Set();
  if (tokens.length < n) {
    tokens.forEach((t) => set.add(t));
    return set;
  }
  for (let i = 0; i + n <= tokens.length; i++) {
    set.add(tokens.slice(i, i + n).join(' '));
  }
  return set;
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
export function mixedSimilarity(textA, textB) {
  const tokA = tokenize(textA);
  const tokB = tokenize(textB);
  const j1 = jaccard(ngrams(tokA, 1), ngrams(tokB, 1));
  const j2 = jaccard(ngrams(tokA, 2), ngrams(tokB, 2));
  const j3 = jaccard(ngrams(tokA, 3), ngrams(tokB, 3));
  return 0.55 * j1 + 0.30 * j2 + 0.15 * j3;
}

/**
 * Retorna a similaridade média par-a-par entre os textos.
 * 1.0 = idênticos, 0.0 = nada em comum.
 */
export function avgSimilarity(texts) {
  const clean = texts.map((t) => (t || '').trim()).filter((t) => t.length > 0);
  if (clean.length < 2) return 1;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < clean.length; i++) {
    for (let j = i + 1; j < clean.length; j++) {
      sum += mixedSimilarity(clean[i], clean[j]);
      count++;
    }
  }
  return count === 0 ? 1 : sum / count;
}

// Limiares pra decisões de fluxo. Configuráveis via env.
// Calibrados pra similaridade mista (uni 0.55 + bi 0.30 + tri 0.15).
export const SIMILARITY_SKIP_CRITIQUE = Number(process.env.SIMILARITY_SKIP_CRITIQUE) || 0.30;
export const SIMILARITY_EARLY_EXIT = Number(process.env.SIMILARITY_EARLY_EXIT) || 0.55;
// Quando 2 drafts ultrapassam isso, são considerados "praticamente o mesmo" — em R2
// só o representante (mais longo) é mostrado aos revisores. Economiza input.
export const SIMILARITY_DEDUP = Number(process.env.SIMILARITY_DEDUP) || 0.7;

/**
 * Agrupa drafts altamente similares e devolve apenas um representante por grupo
 * (o mais longo). Usado pra encurtar o input das rodadas de crítica/síntese
 * quando 2+ modelos convergem mas não o bastante pra early-exit.
 */
export function dedupeDrafts(drafts, threshold = SIMILARITY_DEDUP) {
  if (!Array.isArray(drafts) || drafts.length <= 1) return drafts;
  const sorted = [...drafts].sort(
    (a, b) => (b.texto?.length || 0) - (a.texto?.length || 0)
  );
  const kept = [];
  for (const d of sorted) {
    const dup = kept.some(
      (k) => mixedSimilarity(k.texto || '', d.texto || '') >= threshold
    );
    if (!dup) kept.push(d);
  }
  return kept;
}

/**
 * Decide se vale rodar R2 dado os rascunhos da R1.
 * Retorna { skip: bool, earlyExit: bool, similarity: number, bestIndex: number }.
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

// prompts.js — system prompts e formatação do material trocado entre rodadas.
import { DRAFT_TRUNCATE_CHARS } from '../config.js';

export const PROMPT_CRITICA = `Você viu sua resposta inicial e as dos outros do painel. Produza, nesta ordem:

[CRÍTICA]
Análise breve: erros factuais, lacunas, divergências e onde você estava errado.

[RESPOSTA REVISADA]
Sua resposta final à pergunta original, incorporando o que aprendeu.

Use exatamente esses marcadores, sem nada antes ou depois.`;

// Versão enxuta usada quando o prompt é de código. ~30 tok vs ~70.
export const PROMPT_CRITICA_CODE = `Compare sua resposta com as outras. Produza, nesta ordem:

[CRÍTICA]
Bugs, edge cases ou erros que você ou os outros cometeram. Curto.

[RESPOSTA REVISADA]
Código revisado, em bloco \`\`\`. Sem preâmbulo.

Use exatamente esses marcadores.`;

export const PROMPT_SINTESE = `Você é o agregador final do painel. Consolide as respostas revisadas numa única resposta autoritativa. Não mencione modelos nem o processo de debate. Onde houver convergência, é provavelmente o caminho. Onde houver divergência, decida pelo mérito técnico ou sinalize incerteza.`;

export const PROMPT_SINTESE_DRAFTS = `Você é o agregador do painel. Recebeu os rascunhos paralelos dos modelos para a mesma pergunta. Consolide numa única resposta autoritativa, escolhendo o melhor de cada um e corrigindo erros. Não mencione modelos nem o processo.`;

// Adicionado quando o roteador detecta pergunta de código.
export const PROMPT_CODER_SUFFIX = `Para perguntas de código: responda com o código primeiro, em bloco \`\`\`. Sem preâmbulo. Explicação adicional só se necessária para entender, em no máximo 2 linhas. Não repita a pergunta.`;

export const PROMPT_SUMMARIZE = `Resuma a conversa abaixo em até 350 caracteres, em terceira pessoa. Inclua: o que o usuário pediu, decisões importantes, código gerado relevante. Sem floreios — só o resumo, direto.`;

// Delimitadores das respostas embutidas no prompt de outro modelo. Sem eles, um
// rascunho que por acaso contenha "[RESPOSTA REVISADA]" ou "### Label" confunde
// tanto o modelo seguinte quanto o parser da rodada.
const OPEN = '<<<INICIO';
const CLOSE = '<<<FIM';

export function truncateDraft(texto, limit = DRAFT_TRUNCATE_CHARS) {
  const text = String(texto || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…[truncado]`;
}

/** Neutraliza marcadores de controle vindos do texto de um modelo. */
export function sanitizeForEmbedding(texto) {
  return String(texto || '')
    .replace(/\[\s*CR[ÍI]TICA\s*\]/gi, '(crítica)')
    .replace(/\[\s*RESPOSTA\s+REVISADA\s*\]/gi, '(resposta revisada)')
    .replace(/<<<\s*(INICIO|FIM)\b/gi, '‹‹‹$1');
}

/** Um bloco delimitado e higienizado, pronto pra entrar no prompt de outro modelo. */
export function formatBlock(label, texto) {
  const safeLabel = String(label || 'modelo').replace(/[\r\n>]/g, ' ').trim();
  return `${OPEN} ${safeLabel}>>>\n${sanitizeForEmbedding(truncateDraft(texto))}\n${CLOSE} ${safeLabel}>>>`;
}

export function formatBlocks(items) {
  return items.map((r) => formatBlock(r.label ?? r.model, r.texto)).join('\n\n');
}

export function makeSystem(...parts) {
  return parts.filter((p) => p && p.trim()).join('\n\n') || undefined;
}

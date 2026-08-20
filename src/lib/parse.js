// parse.js — extração da crítica / resposta revisada produzidas na rodada 2.

const RE_REVISADA = /\[\s*RESPOSTA\s+REVISADA\s*\]([\s\S]*)/i;
const RE_CRITICA_ATE_REVISADA = /\[\s*CR[ÍI]TICA\s*\]([\s\S]*?)(?=\[\s*RESPOSTA\s+REVISADA\s*\])/i;
const RE_CRITICA = /\[\s*CR[ÍI]TICA\s*\]([\s\S]*)/i;

/**
 * Retorna `{ critica, resposta_revisada }`.
 *
 * Sem os marcadores, o texto inteiro vira `resposta_revisada` — a versão antiga
 * partia os parágrafos ao meio e chamava a primeira metade de crítica, o que
 * mutilava respostas válidas. `resposta_revisada` vazio é sinal pro caller usar
 * o rascunho original do modelo como fallback.
 */
export function parseCriticaERevisao(texto) {
  const raw = typeof texto === 'string' ? texto.trim() : '';
  if (!raw) return { critica: '', resposta_revisada: '' };

  const revisada = raw.match(RE_REVISADA);
  if (revisada) {
    const corpo = revisada[1].trim();
    if (corpo) {
      const critica = raw.match(RE_CRITICA_ATE_REVISADA);
      return { critica: critica ? critica[1].trim() : '', resposta_revisada: corpo };
    }
  }

  // Só a crítica veio (ou o marcador de revisada existe mas com corpo vazio):
  // não há resposta revisada confiável pra extrair.
  const criticaOnly = raw.match(RE_CRITICA);
  if (criticaOnly) {
    const corpo = criticaOnly[1].replace(/\[\s*RESPOSTA\s+REVISADA\s*\][\s\S]*$/i, '');
    return { critica: corpo.trim(), resposta_revisada: '' };
  }

  return { critica: '', resposta_revisada: raw };
}

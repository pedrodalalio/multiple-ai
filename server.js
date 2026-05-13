import 'dotenv/config';
import express from 'express';
import { generateText } from 'ai';
import { MODELS, listModels, DEFAULT_MODEL_IDS } from './models.js';

const TIMEOUT_MS = Number(process.env.MODEL_TIMEOUT_MS) || 60_000;

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

function ts() {
  return new Date().toISOString().slice(11, 23);
}

function log(prefixColor, prefix, msg) {
  console.log(`${C.gray}${ts()}${C.reset} ${prefixColor}${prefix}${C.reset} ${msg}`);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, _res, next) => {
  log(C.gray, '→', `${C.bold}${req.method}${C.reset} ${req.path}`);
  next();
});

app.get('/models', (_req, res) => {
  res.json({ models: listModels(), defaults: DEFAULT_MODEL_IDS });
});

async function chamarModelo(id, messages, etiqueta, system) {
  const entry = MODELS[id];
  const tag = etiqueta ? `[${etiqueta}] ` : '';
  log(C.cyan, '⟳', `${tag}${C.bold}${id}${C.reset} ${C.dim}iniciando...${C.reset}`);
  const inicio = Date.now();
  try {
    const { text, usage } = await generateText({
      model: entry.model,
      system,
      messages,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
    });
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
      texto: text,
    };
  } catch (err) {
    const ms = Date.now() - inicio;
    const mensagem = err instanceof Error ? err.message : String(err);
    log(C.red, '✗', `${tag}${C.bold}${id}${C.reset} ${ms}ms ${C.red}${mensagem}${C.reset}`);
    return {
      model: id,
      label: entry.label,
      provider: entry.provider,
      ms,
      erro: mensagem,
      texto: '[este modelo falhou]',
    };
  }
}

const PROMPT_CRITICA = `Você está em um painel de IAs trabalhando em conjunto para responder a uma pergunta.

Você já produziu uma resposta inicial. Agora vai ver as respostas dos outros modelos do painel.

Sua tarefa em duas partes:

1. CRÍTICA: analise criticamente as respostas dos outros modelos e também a sua própria. Aponte:
   - Erros factuais ou imprecisões
   - Lacunas importantes
   - Pontos onde você discorda e por quê
   - Pontos onde os outros estão certos e você estava errado ou incompleto

2. RESPOSTA REVISADA: depois de considerar tudo, produza sua resposta final revisada à pergunta original. Incorpore o que aprendeu, corrija seus próprios erros se for o caso, e mantenha sua posição onde tiver razão fundamentada para discordar.

Formato obrigatório da sua saída — use exatamente estes marcadores, sem nada antes ou depois:

[CRÍTICA]
(sua análise crítica aqui)

[RESPOSTA REVISADA]
(sua resposta final à pergunta original aqui)`;

const PROMPT_SINTESE = `Você é o agregador final de um painel de IAs que trabalhou em colaboração.

Você recebeu a pergunta original, as respostas iniciais de cada modelo, as críticas que cada modelo fez após ver os demais, e as respostas revisadas após o debate.

Sua tarefa: produzir a melhor resposta final possível. Onde houve convergência entre os modelos após o debate, esse é provavelmente o caminho mais sólido. Onde houver divergência persistente entre modelos competentes, decida pelo mérito técnico — ou sinalize honestamente a incerteza se for o caso.

Responda como uma única resposta autoritativa e consolidada. Não diga "o modelo X afirmou" nem mencione o processo de debate — apenas a resposta final, como se você fosse o único respondendo.`;

function parseCriticaERevisao(texto) {
  const matchCritica = texto.match(/\[CRÍTICA\]([\s\S]*?)(?=\[RESPOSTA REVISADA\]|$)/i);
  const matchRevisao = texto.match(/\[RESPOSTA REVISADA\]([\s\S]*)/i);
  if (matchRevisao) {
    return {
      critica: matchCritica ? matchCritica[1].trim() : '',
      resposta_revisada: matchRevisao[1].trim(),
    };
  }
  return { critica: '', resposta_revisada: texto };
}

app.post('/chat', async (req, res) => {
  const { prompt, modelos: requestedIds, agregador: agregadorInput } = req.body ?? {};

  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return res.status(400).json({ error: 'Body deve ter { prompt: string }' });
  }

  const ids = Array.isArray(requestedIds) && requestedIds.length > 0
    ? requestedIds
    : DEFAULT_MODEL_IDS;

  const desconhecidos = ids.filter((id) => !MODELS[id]);
  if (desconhecidos.length > 0) {
    return res.status(400).json({
      error: `Modelos desconhecidos: ${desconhecidos.join(', ')}`,
    });
  }

  const agregador = agregadorInput || 'llama-3.3-70b';
  if (!MODELS[agregador]) {
    return res.status(400).json({ error: `Agregador desconhecido: ${agregador}` });
  }

  const promptPreview = prompt.length > 80 ? prompt.slice(0, 80) + '…' : prompt;
  log(C.magenta, '◆', `${C.bold}/chat${C.reset} prompt: ${C.dim}"${promptPreview}"${C.reset}`);
  log(C.magenta, '◆', `painel: ${ids.join(', ')} | agregador: ${agregador}`);

  const inicioTotal = Date.now();

  log(C.magenta, '◆', `${C.bold}rodada 1:${C.reset} rascunhos independentes`);
  const rascunhos = await Promise.all(
    ids.map((id) => chamarModelo(id, [{ role: 'user', content: prompt }], 'rascunho'))
  );

  log(C.magenta, '◆', `${C.bold}rodada 2:${C.reset} crítica + revisão (cada modelo vê os outros)`);
  const revisoesBrutas = await Promise.all(
    ids.map((id, idx) => {
      const outrasRespostas = rascunhos
        .map((r, i) => (i === idx ? null : `### ${r.label}\n${r.texto}`))
        .filter(Boolean)
        .join('\n\n---\n\n');
      const minhaResposta = `### Sua resposta inicial (${rascunhos[idx].label})\n${rascunhos[idx].texto}`;
      const userMsg = `Pergunta original:\n${prompt}\n\n${minhaResposta}\n\n---\n\nRespostas dos outros modelos do painel:\n\n${outrasRespostas}\n\nProduza agora sua crítica e sua resposta revisada no formato indicado.`;
      return chamarModelo(id, [{ role: 'user', content: userMsg }], 'revisão', PROMPT_CRITICA);
    })
  );

  const revisoes = revisoesBrutas.map((r) => {
    if (r.erro) return { ...r, critica: '', resposta_revisada: r.texto };
    const { critica, resposta_revisada } = parseCriticaERevisao(r.texto);
    return { ...r, critica, resposta_revisada };
  });

  log(C.magenta, '◆', `${C.bold}rodada 3:${C.reset} síntese final pelo agregador`);
  const contextoSintese = revisoes
    .map((r) => {
      const partes = [`### ${r.label}`];
      if (r.critica) partes.push(`Crítica que fez:\n${r.critica}`);
      partes.push(`Resposta revisada:\n${r.resposta_revisada}`);
      return partes.join('\n\n');
    })
    .join('\n\n---\n\n');

  const messagesSintese = [
    {
      role: 'user',
      content: `Pergunta original:\n${prompt}\n\nResultado do debate do painel:\n\n${contextoSintese}\n\nProduza agora a resposta final consolidada.`,
    },
  ];

  const ordemAgregadores = [agregador, ...ids.filter((id) => id !== agregador)];
  let sintese = null;
  for (const candidato of ordemAgregadores) {
    sintese = await chamarModelo(candidato, messagesSintese, `síntese[${candidato}]`, PROMPT_SINTESE);
    if (!sintese.erro) break;
    log(C.yellow, '↻', `agregador ${C.bold}${candidato}${C.reset} falhou, tentando próximo...`);
  }

  const msTotal = Date.now() - inicioTotal;
  const falhas = [...rascunhos, ...revisoesBrutas].filter((r) => r.erro).length;
  const statusColor = falhas > 0 ? C.yellow : C.green;
  const statusIcon = falhas > 0 ? '⚠' : '✓';
  log(
    statusColor,
    statusIcon,
    `${C.bold}/chat${C.reset} concluído em ${msTotal}ms${falhas > 0 ? ` (${falhas} chamada(s) falharam)` : ''}`
  );

  res.json({
    prompt,
    rascunhos,
    revisoes,
    resposta_conjunta: sintese.texto,
    agregador,
    ms_total: msTotal,
  });
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, () => {
  console.log(`\n${C.bold}many-ais${C.reset} rodando em ${C.cyan}http://localhost:${port}${C.reset}`);
  console.log(`${C.dim}timeout por modelo: ${TIMEOUT_MS}ms (override com env MODEL_TIMEOUT_MS)${C.reset}`);
  console.log(`${C.dim}endpoints: GET /models  |  POST /chat${C.reset}\n`);
});

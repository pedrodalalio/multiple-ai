# many-ais

Painel de IAs: você pergunta uma vez, vários modelos respondem em paralelo,
leem e criticam as respostas uns dos outros, revisam a própria resposta — e um
agregador consolida tudo numa resposta final.

Backend Node/Express com streaming SSE e persistência em SQLite; frontend React
+ Vite + Tailwind.

---

## Como rodar

Requisitos: **Node >= 20.11** e **pnpm**.

```bash
# 1. dependências
pnpm install
pnpm --dir web install

# 2. chaves
cp .env.example .env    # e preencha ao menos uma API key

# 3. dois terminais
pnpm dev                # backend em http://localhost:3030
pnpm web                # frontend em http://localhost:5173
```

O Vite faz proxy de `/api/*` para o backend, então a porta do servidor
(`PORT`, default `3030`) precisa bater com `BACKEND_URL` do `web/vite.config.ts`.

Basta **uma** API key para o app funcionar: modelos de providers sem chave são
omitidos da lista e o painel se ajusta sozinho. O boot avisa quais faltam.

| Provider | Onde pegar a chave                                   |
| -------- | ---------------------------------------------------- |
| Google   | <https://aistudio.google.com/apikey>                 |
| Groq     | <https://console.groq.com/keys>                      |
| Mistral  | <https://console.mistral.ai/api-keys/>               |

### Outros comandos

```bash
pnpm test        # testes do backend (node:test)
pnpm start       # backend sem --watch
pnpm web:build   # build de produção do frontend
```

---

## Como funciona

Cada pergunta é roteada para um de três modos (`src/classify.js`, tudo por
regex — nenhuma chamada de LLM para decidir):

| Modo                | Quando                                       | Custo       |
| ------------------- | -------------------------------------------- | ----------- |
| `single_fast`       | código objetivo, "como faço X em Y"          | 1 chamada   |
| `panel_no_critique` | pergunta curta e factual                     | N + 1       |
| `panel_full`        | opinativo, arquitetural, review de código    | até 2N + 1  |

O modo pode ser forçado pela UI (botão "modo:" no composer).

Em `panel_full`, depois da rodada de rascunhos o servidor mede a similaridade
entre as respostas (Jaccard sobre n-gramas) e decide:

- **muito parecidas** → *early-exit*: o melhor rascunho já é a resposta;
- **parecidas** → pula a rodada de crítica, vai direto pra síntese;
- **divergentes** → roda a crítica/revisão completa.

Outras economias de token: janela curta de histórico com sumarização do que
ficou pra trás, truncagem e dedupe dos rascunhos passados adiante, painel
reduzido automaticamente em contexto de código, e caps de output por rodada.
Todos os limiares são configuráveis por env — veja `.env.example`.

---

## Estrutura

```
server.js              wiring do Express, boot e shutdown
src/
  config.js            leitura e validação de todas as env vars
  models.js            registro de modelos + quais têm API key
  classify.js          roteamento de modo e similaridade entre rascunhos
  db.js                SQLite (schema, migrations, queries)
  routes.js            endpoints REST + SSE
  chat/run.js          orquestração de um turno (rodadas 1-3)
  lib/
    model-stream.js    chamada streamada, retry, timeouts
    sse.js             canal SSE com heartbeat
    context.js         janela de histórico + sumarização
    prompts.js         system prompts e formatação entre rodadas
    parse.js           parsing de [CRÍTICA] / [RESPOSTA REVISADA]
    middleware.js      CORS, auth, rate limit
test/                  testes (node --test)
web/                   frontend React
```

---

## API

| Método   | Rota                     | Descrição                                  |
| -------- | ------------------------ | ------------------------------------------ |
| `GET`    | `/health`                | status e providers faltando                |
| `GET`    | `/models`                | modelos disponíveis e defaults             |
| `GET`    | `/conversations`         | lista (`?limit=`, `?offset=`)              |
| `GET`    | `/conversations/:id`     | detalhe (`?limit=`, `?before=` cursor)     |
| `DELETE` | `/conversations/:id`     | remove a conversa e tudo dela              |
| `POST`   | `/chat/stream`           | **SSE** — o turno inteiro                  |

`POST /chat/stream` aceita `{ prompt, conversation_id?, modelos?, agregador?, mode? }`
e emite eventos `meta`, `phase`, `similarity`, `draft_*`, `revision_*`,
`synthesis_*`, `done` e `error`. Os eventos `*_reset` avisam que o servidor vai
retentar um modelo e reemitir o texto — o cliente descarta o parcial.

---

## Segurança

Em localhost o default é aberto. Antes de expor na rede:

- `API_TOKEN` — exige `Authorization: Bearer <token>`. No frontend, defina
  `VITE_API_TOKEN` em `web/.env`.
- `CORS_ORIGINS` — allowlist de origens (default: as portas locais do Vite).
- `CHAT_RATE_LIMIT_MAX` — chamadas de chat por IP por minuto (default 20).
- `MAX_PROMPT_CHARS` — teto de tamanho do prompt (default 32k).

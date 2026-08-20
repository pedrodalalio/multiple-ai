// Roda contra um sqlite temporário — DB_PATH precisa ser setado antes do import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'many-ais-test-'));
process.env.DB_PATH = join(dir, 'test.db');

const {
  addMessage,
  closeDb,
  countHistoryMessages,
  createConversation,
  listConversationMessages,
  listRecentHistory,
  saveAssistantTurn,
} = await import('../src/db.js');

test.after(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

function novaConversa() {
  return createConversation({ title: 't', panel: ['a'], aggregator: 'a' });
}

test('saveAssistantTurn grava mensagem e painel atomicamente', () => {
  const conv = novaConversa();
  addMessage(conv.id, 'user', 'oi');
  const saved = saveAssistantTurn(conv.id, {
    content: 'olá',
    isError: false,
    drafts: [{ model: 'a', texto: 'rascunho' }],
    revisions: [],
    synthesis_text: 'olá',
    synthesis_model: 'a',
    error: null,
    ms_total: 42,
    mode: 'panel_full',
  });

  const page = listConversationMessages(conv.id);
  assert.equal(page.messages.length, 2);
  const assistente = page.messages[1];
  assert.equal(assistente.id, saved.id);
  assert.equal(assistente.panel.synthesis_text, 'olá');
  assert.equal(assistente.panel.drafts[0].texto, 'rascunho');
  assert.equal(assistente.panel.ms_total, 42);
});

test('turnos com erro ficam fora do contexto mandado aos modelos', () => {
  const conv = novaConversa();
  addMessage(conv.id, 'user', 'pergunta 1');
  saveAssistantTurn(conv.id, {
    content: '[erro] rate limit',
    isError: true,
    drafts: [],
    revisions: [],
    error: 'rate limit',
    ms_total: 1,
    mode: 'panel_full',
  });
  addMessage(conv.id, 'user', 'pergunta 2');

  const history = listRecentHistory(conv.id, 10);
  assert.deepEqual(
    history.map((m) => m.content),
    ['pergunta 1', 'pergunta 2'],
    'a mensagem de erro não entra no histórico'
  );
  assert.equal(countHistoryMessages(conv.id), 2);

  // Mas continua visível na UI.
  const page = listConversationMessages(conv.id);
  assert.equal(page.messages.length, 3);
  assert.equal(page.messages[1].is_error, true);
});

test('listConversationMessages pagina do mais recente para trás', () => {
  const conv = novaConversa();
  for (let i = 0; i < 5; i++) addMessage(conv.id, 'user', `m${i}`);

  const page = listConversationMessages(conv.id, { limit: 2 });
  assert.deepEqual(page.messages.map((m) => m.content), ['m3', 'm4']);
  assert.equal(page.has_more, true);
  assert.ok(page.next_before);

  const anterior = listConversationMessages(conv.id, { limit: 2, before: page.next_before });
  assert.deepEqual(anterior.messages.map((m) => m.content), ['m1', 'm2']);

  const primeira = listConversationMessages(conv.id, { limit: 10, before: anterior.next_before });
  assert.deepEqual(primeira.messages.map((m) => m.content), ['m0']);
  assert.equal(primeira.has_more, false);
});

test('mensagem sem painel devolve panel null', () => {
  const conv = novaConversa();
  addMessage(conv.id, 'user', 'sozinha');
  const page = listConversationMessages(conv.id);
  assert.equal(page.messages[0].panel, null);
});

test('deletar a conversa remove mensagens e painéis em cascata', async () => {
  const { deleteConversation, countMessages } = await import('../src/db.js');
  const conv = novaConversa();
  addMessage(conv.id, 'user', 'oi');
  saveAssistantTurn(conv.id, {
    content: 'tchau',
    drafts: [],
    revisions: [],
    ms_total: 1,
  });
  assert.equal(countMessages(conv.id), 2);
  deleteConversation(conv.id);
  assert.equal(countMessages(conv.id), 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  avgSimilarity,
  classifyPrompt,
  decideAfterDrafts,
  dedupeDrafts,
  hasCodeSignals,
  isSelfContainedPrompt,
  mixedSimilarity,
} from '../src/classify.js';

test('hasCodeSignals detecta fences, tokens e keywords', () => {
  assert.equal(hasCodeSignals('```js\nconst a = 1\n```'), true);
  assert.equal(hasCodeSignals('como uso o useEffect no react?'), true);
  assert.equal(hasCodeSignals('TypeError: cannot read property of undefined'), true);
  assert.equal(hasCodeSignals('qual a capital da França?'), false);
  assert.equal(hasCodeSignals(''), false);
  assert.equal(hasCodeSignals(null), false);
});

test('classifyPrompt roteia código objetivo para single_fast', () => {
  assert.equal(classifyPrompt('como faço um debounce em typescript?'), 'single_fast');
});

test('classifyPrompt manda código + review para o painel completo', () => {
  assert.equal(classifyPrompt('revisa esse código typescript e acha o bug'), 'panel_full');
  assert.equal(classifyPrompt('qual a melhor abordagem de arquitetura pra esse express?'), 'panel_full');
});

test('classifyPrompt separa opinativo de factual curto', () => {
  assert.equal(classifyPrompt('qual o melhor jeito de aprender a cozinhar?'), 'panel_full');
  assert.equal(classifyPrompt('quem pintou a Mona Lisa?'), 'panel_no_critique');
});

test('classifyPrompt tem default seguro para entrada inválida', () => {
  assert.equal(classifyPrompt(null), 'panel_full');
  assert.equal(classifyPrompt('   '), 'panel_full');
});

test('isSelfContainedPrompt exige fence, tamanho e ausência de referência', () => {
  const longCode = `Explica a função abaixo:\n\`\`\`js\n${'const x = 1;\n'.repeat(20)}\`\`\``;
  assert.equal(isSelfContainedPrompt(longCode), true);

  // Referência a turno anterior na prosa desqualifica.
  assert.equal(isSelfContainedPrompt(`Agora corrige isso:\n${longCode}`), false);
  // Curto demais.
  assert.equal(isSelfContainedPrompt('```js\nconst a=1\n```'), false);
  // Sem fence.
  assert.equal(isSelfContainedPrompt('x'.repeat(400)), false);
});

test('isSelfContainedPrompt ignora keywords dentro da fence', () => {
  // `continue` é keyword de JS, não referência a turno anterior.
  const code = `Explica o loop abaixo:\n\`\`\`js\n${'if (x) continue;\n'.repeat(20)}\`\`\``;
  assert.equal(isSelfContainedPrompt(code), true);
});

test('isSelfContainedPrompt é conservador com pronomes na prosa', () => {
  // "essa função" aponta pro código do próprio prompt, mas a heurística não
  // distingue — e errar pro lado de incluir o histórico é o seguro.
  const code = `Explica o que essa função faz:\n\`\`\`js\n${'const x = 1;\n'.repeat(20)}\`\`\``;
  assert.equal(isSelfContainedPrompt(code), false);
});

test('mixedSimilarity: idênticos = 1, disjuntos = 0', () => {
  assert.equal(mixedSimilarity('o gato subiu no telhado', 'o gato subiu no telhado'), 1);
  assert.equal(mixedSimilarity('abc def', 'xyz uvw'), 0);
});

test('mixedSimilarity ignora acentos e pontuação', () => {
  assert.equal(mixedSimilarity('avião, café!', 'aviao cafe'), 1);
});

test('avgSimilarity com menos de 2 textos úteis vale 1', () => {
  assert.equal(avgSimilarity([]), 1);
  assert.equal(avgSimilarity(['só um']), 1);
  assert.equal(avgSimilarity(['texto', '   ']), 1);
});

test('dedupeDrafts mantém o representante mais longo', () => {
  const base = 'a resposta correta é usar um índice composto na coluna';
  const drafts = [
    { model: 'a', texto: base },
    { model: 'b', texto: `${base} de data` },
    { model: 'c', texto: 'algo completamente diferente sobre culinária italiana' },
  ];
  const kept = dedupeDrafts(drafts, 0.7);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].model, 'b', 'mantém o mais longo do grupo duplicado');
  assert.ok(kept.some((k) => k.model === 'c'));
});

test('dedupeDrafts é no-op para 0 ou 1 draft', () => {
  assert.deepEqual(dedupeDrafts([]), []);
  const one = [{ model: 'a', texto: 'x' }];
  assert.deepEqual(dedupeDrafts(one), one);
});

test('decideAfterDrafts aponta o rascunho mais longo como melhor', () => {
  const d = decideAfterDrafts([
    { texto: 'curto' },
    { texto: 'um rascunho bem mais longo que o outro' },
  ]);
  assert.equal(d.bestIndex, 1);
  assert.ok(d.similarity >= 0 && d.similarity <= 1);
});

test('decideAfterDrafts faz early-exit quando os rascunhos convergem', () => {
  const texto = 'para ordenar um array em javascript use o método sort com comparador';
  const d = decideAfterDrafts([{ texto }, { texto }]);
  assert.equal(d.earlyExit, true);
  assert.equal(d.skip, true);
});

test('decideAfterDrafts roda R2 quando os rascunhos divergem', () => {
  const d = decideAfterDrafts([
    { texto: 'primeiro fale sobre bancos relacionais e normalizacao' },
    { texto: 'prefira armazenamento colunar orientado a analytics' },
  ]);
  assert.equal(d.earlyExit, false);
  assert.equal(d.skip, false);
});

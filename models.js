import { google } from '@ai-sdk/google';
import { groq } from '@ai-sdk/groq';
import { mistral } from '@ai-sdk/mistral';

export const MODELS = {
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'google',
    model: google('gemini-2.5-flash'),
  },
  'llama-3.3-70b': {
    id: 'llama-3.3-70b',
    label: 'Llama 3.3 70B (Groq)',
    provider: 'groq',
    model: groq('llama-3.3-70b-versatile'),
  },
  'mistral-small': {
    id: 'mistral-small',
    label: 'Mistral Small',
    provider: 'mistral',
    model: mistral('mistral-small-latest'),
  },
};

export const DEFAULT_MODEL_IDS = [
  'gemini-2.5-flash',
  'llama-3.3-70b',
  'mistral-small',
];

export const DEFAULT_AGGREGATOR_ID = 'llama-3.3-70b';

// Modelo único usado quando o roteador decide "single_fast" (perguntas objetivas
// de código, snippets, debug). Llama 3.3 70B no Groq é rápido e bom em código.
export const DEFAULT_CODER_MODEL_ID = 'llama-3.3-70b';

// Modelo barato/rápido usado para sumarizar histórico antigo.
// Gemini Flash tem janela grande e custo baixo.
export const DEFAULT_SUMMARIZER_MODEL_ID = 'gemini-2.5-flash';

export function listModels() {
  return Object.values(MODELS).map(({ id, label, provider }) => ({
    id,
    label,
    provider,
  }));
}

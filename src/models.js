// models.js — registro de modelos + descoberta de quais estão realmente utilizáveis.
//
// As instâncias de provider são criadas sob demanda (lazy) para que a ausência de
// uma API key nunca derrube o import do módulo — ela vira "modelo indisponível".
import { google } from '@ai-sdk/google';
import { groq } from '@ai-sdk/groq';
import { mistral } from '@ai-sdk/mistral';

export const PROVIDER_ENV_KEYS = {
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
  groq: 'GROQ_API_KEY',
  mistral: 'MISTRAL_API_KEY',
};

const REGISTRY = [
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    provider: 'google',
    create: () => google('gemini-2.5-flash'),
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B (Groq)',
    provider: 'groq',
    create: () => groq('openai/gpt-oss-120b'),
  },
  {
    id: 'mistral-small',
    label: 'Mistral Small',
    provider: 'mistral',
    create: () => mistral('mistral-small-latest'),
  },
];

/** Metadados apenas — sem instância de SDK. */
export const MODELS = Object.fromEntries(
  REGISTRY.map((m) => [m.id, { id: m.id, label: m.label, provider: m.provider }])
);

const instances = new Map();

export function getModelInstance(id) {
  if (!instances.has(id)) {
    const entry = REGISTRY.find((m) => m.id === id);
    if (!entry) throw new Error(`Modelo desconhecido: ${id}`);
    instances.set(id, entry.create());
  }
  return instances.get(id);
}

export function isProviderConfigured(provider) {
  const envKey = PROVIDER_ENV_KEYS[provider];
  if (!envKey) return true;
  return Boolean((process.env[envKey] || '').trim());
}

export function isModelAvailable(id) {
  const meta = MODELS[id];
  return Boolean(meta) && isProviderConfigured(meta.provider);
}

export function availableModelIds() {
  return REGISTRY.filter((m) => isProviderConfigured(m.provider)).map((m) => m.id);
}

/** Só os modelos que têm chave configurada — a UI não deve oferecer o resto. */
export function listModels() {
  return REGISTRY.filter((m) => isProviderConfigured(m.provider)).map(({ id, label, provider }) => ({
    id,
    label,
    provider,
  }));
}

/** Modelos conhecidos mas sem chave — a UI mostra como hint de configuração. */
export function listUnavailableModels() {
  return REGISTRY.filter((m) => !isProviderConfigured(m.provider)).map(({ id, label, provider }) => ({
    id,
    label,
    provider,
    reason: `${PROVIDER_ENV_KEYS[provider]} não configurada`,
  }));
}

// Ordens de preferência: o primeiro disponível vence. Assim a app continua
// funcionando com apenas um provider configurado.
const PREFERRED_PANEL = ['gemini-2.5-flash', 'gpt-oss-120b', 'mistral-small'];
const PREFERRED_AGGREGATOR = ['gpt-oss-120b', 'gemini-2.5-flash', 'mistral-small'];
const PREFERRED_CODER = ['gpt-oss-120b', 'gemini-2.5-flash', 'mistral-small'];
const PREFERRED_SUMMARIZER = ['gemini-2.5-flash', 'mistral-small', 'gpt-oss-120b'];

const firstAvailable = (prefs) => prefs.find(isModelAvailable) ?? null;

export function defaultModelIds() {
  return PREFERRED_PANEL.filter(isModelAvailable);
}

/** Modelo do agregador final (faz a síntese). */
export const defaultAggregatorId = () => firstAvailable(PREFERRED_AGGREGATOR);

/** Modelo único usado quando o roteador decide `single_fast`. Rápido e bom em código. */
export const defaultCoderModelId = () => firstAvailable(PREFERRED_CODER);

/** Modelo barato/rápido pra sumarizar histórico antigo. */
export const defaultSummarizerModelId = () => firstAvailable(PREFERRED_SUMMARIZER);

export function missingProviders() {
  return Object.entries(PROVIDER_ENV_KEYS)
    .filter(([provider]) => !isProviderConfigured(provider))
    .map(([provider, envKey]) => ({ provider, envKey }));
}

export type Provider = 'google' | 'groq' | 'mistral' | string;

export interface ModelInfo {
  id: string;
  label: string;
  provider: Provider;
}

export interface ModelsResponse {
  models: ModelInfo[];
  defaults: string[];
  default_aggregator: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  panel: string[];
  aggregator: string;
  created_at: number;
  updated_at: number;
}

export interface PanelDraft {
  model: string;
  label?: string;
  provider?: string;
  ms?: number;
  tokens_input?: number | null;
  tokens_output?: number | null;
  erro?: string | null;
  texto: string;
}

export interface PanelRevision {
  model: string;
  label?: string;
  provider?: string;
  ms?: number;
  critica: string;
  resposta_revisada: string;
  texto?: string;
  texto_bruto?: string;
  erro?: string | null;
}

export interface PanelRun {
  id: string;
  drafts: PanelDraft[];
  revisions: PanelRevision[];
  synthesis_text: string | null;
  synthesis_model: string | null;
  error: string | null;
  ms_total: number;
  created_at: number;
  mode?: string | null;
}

export type ChatMode = 'auto' | 'single_fast' | 'panel_no_critique' | 'panel_full';

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
  panel: PanelRun | null;
}

export interface ConversationDetail {
  conversation: ConversationSummary;
  messages: StoredMessage[];
}

// ---------- streaming/live shapes (in-memory while SSE is running) ----------

export type Phase = 'idle' | 'drafts' | 'revisions' | 'synthesis' | 'done' | 'error';

export interface LiveModelState {
  model: string;
  label: string;
  provider: string;
  draft: string;
  draftStatus: 'pending' | 'streaming' | 'done' | 'error';
  draftMs?: number;
  draftError?: string | null;
  draftTokensIn?: number | null;
  draftTokensOut?: number | null;

  revision: string;
  critica: string;
  respostaRevisada: string;
  revisionStatus: 'pending' | 'streaming' | 'done' | 'error' | 'skipped';
  revisionMs?: number;
  revisionError?: string | null;
}

export interface LivePanel {
  conversationId: string;
  userMessageId: string;
  models: LiveModelState[];
  aggregatorId: string;
  phase: Phase;
  synthesis: string;
  synthesisModel: string | null;
  synthesisStatus: 'pending' | 'streaming' | 'done' | 'error';
  synthesisError: string | null;
  synthesisFallbacks: { model: string; erro: string }[];
  msTotal?: number;
  topLevelError?: string;
  assistantMessageId?: string;
  mode?: string;
  classified?: string;
  similarity?: number | null;
  earlyExit?: boolean;
  skipR2Reason?: string | null;
}

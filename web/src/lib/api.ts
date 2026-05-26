import type {
  ConversationDetail,
  ConversationSummary,
  ModelsResponse,
} from './types';

const API = '/api';

export async function fetchModels(): Promise<ModelsResponse> {
  const r = await fetch(`${API}/models`);
  if (!r.ok) throw new Error('failed to load models');
  return r.json();
}

export async function fetchConversations(): Promise<{ conversations: ConversationSummary[] }> {
  const r = await fetch(`${API}/conversations`);
  if (!r.ok) throw new Error('failed to load conversations');
  return r.json();
}

export async function fetchConversation(id: string): Promise<ConversationDetail> {
  const r = await fetch(`${API}/conversations/${id}`);
  if (!r.ok) throw new Error('conversation not found');
  return r.json();
}

export async function deleteConversation(id: string): Promise<void> {
  await fetch(`${API}/conversations/${id}`, { method: 'DELETE' });
}

// ---------- SSE streaming ----------

export interface StreamRequest {
  prompt: string;
  conversation_id?: string;
  modelos?: string[];
  agregador?: string;
  mode?: 'auto' | 'single_fast' | 'panel_no_critique' | 'panel_full';
}

export type SSEEvent =
  | { type: 'meta'; data: { conversation_id: string; user_message_id: string; panel: { id: string; label: string; provider: string }[]; aggregator: string; mode?: string; classified?: string } }
  | { type: 'phase'; data: { phase: 'drafts' | 'revisions' | 'synthesis'; skipped?: number; reason?: string } }
  | { type: 'similarity'; data: { value: number; skipR2: boolean; earlyExit: boolean } }
  | { type: 'draft_start'; data: { model: string } }
  | { type: 'draft_delta'; data: { model: string; delta: string } }
  | { type: 'draft_done'; data: { model: string; ms: number; tokens_input: number | null; tokens_output: number | null; erro: string | null; texto: string } }
  | { type: 'revision_start'; data: { model: string } }
  | { type: 'revision_delta'; data: { model: string; delta: string } }
  | { type: 'revision_done'; data: { model: string; ms: number; erro: string | null; critica: string; resposta_revisada: string; texto_bruto: string; skipped?: boolean } }
  | { type: 'synthesis_start'; data: { model: string } }
  | { type: 'synthesis_delta'; data: { model: string; delta: string } }
  | { type: 'synthesis_done'; data: { model: string | null; ms?: number; erro: string | null; texto: string; tokens_input?: number; tokens_output?: number; early_exit?: boolean } }
  | { type: 'synthesis_fallback'; data: { model: string; erro: string } }
  | { type: 'done'; data: { ms_total: number; assistant_message_id: string | null; synthesis_error: string | null } }
  | { type: 'error'; data: { error: string } };

export async function streamChat(
  req: StreamRequest,
  onEvent: (ev: SSEEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`chat failed: ${res.status} ${text}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE messages are separated by blank lines
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const lines = chunk.split('\n');
      let eventName = 'message';
      const dataLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (dataLines.length === 0) continue;
      try {
        const data = JSON.parse(dataLines.join('\n'));
        onEvent({ type: eventName as SSEEvent['type'], data } as SSEEvent);
      } catch (e) {
        console.warn('failed to parse SSE event', eventName, e);
      }
    }
  }
}

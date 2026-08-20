import type {
  ConversationDetail,
  ConversationSummary,
  ModelsResponse,
} from './types';

const API = '/api';
// Definido só quando o backend roda com API_TOKEN. Em localhost fica vazio.
const TOKEN = import.meta.env.VITE_API_TOKEN as string | undefined;

function authHeaders(extra?: HeadersInit): HeadersInit {
  return TOKEN ? { ...extra, Authorization: `Bearer ${TOKEN}` } : { ...extra };
}

/** Extrai a mensagem de erro do backend em vez de mostrar só o status. */
async function failure(res: Response, fallback: string): Promise<Error> {
  try {
    const body = await res.json();
    if (body?.error) return new Error(body.error);
  } catch {
    /* resposta sem json */
  }
  return new Error(`${fallback} (HTTP ${res.status})`);
}

async function getJson<T>(path: string, fallback: string): Promise<T> {
  const res = await fetch(`${API}${path}`, { headers: authHeaders() });
  if (!res.ok) throw await failure(res, fallback);
  return res.json() as Promise<T>;
}

export function fetchModels(): Promise<ModelsResponse> {
  return getJson<ModelsResponse>('/models', 'não foi possível carregar os modelos');
}

export function fetchConversations(): Promise<{ conversations: ConversationSummary[] }> {
  return getJson('/conversations', 'não foi possível carregar as conversas');
}

export function fetchConversation(id: string): Promise<ConversationDetail> {
  return getJson<ConversationDetail>(
    `/conversations/${encodeURIComponent(id)}`,
    'conversa não encontrada',
  );
}

export async function deleteConversation(id: string): Promise<void> {
  const res = await fetch(`${API}/conversations/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  });
  if (!res.ok) throw await failure(res, 'não foi possível excluir a conversa');
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
  // *_reset: o backend vai retentar e reemitir o texto desta tentativa do zero.
  | { type: 'draft_reset'; data: { model: string } }
  | { type: 'draft_done'; data: { model: string; ms: number; tokens_input: number | null; tokens_output: number | null; erro: string | null; texto: string } }
  | { type: 'revision_start'; data: { model: string } }
  | { type: 'revision_delta'; data: { model: string; delta: string } }
  | { type: 'revision_reset'; data: { model: string } }
  | { type: 'revision_done'; data: { model: string; ms: number; erro: string | null; critica: string; resposta_revisada: string; texto_bruto: string; skipped?: boolean } }
  | { type: 'synthesis_start'; data: { model: string } }
  | { type: 'synthesis_delta'; data: { model: string; delta: string } }
  | { type: 'synthesis_reset'; data: { model: string } }
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
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(req),
    signal,
  });
  if (!res.ok || !res.body) {
    throw await failure(res, 'a requisição de chat falhou');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Mensagens SSE são separadas por linha em branco.
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let eventName = 'message';
        const dataLines: string[] = [];
        for (const line of chunk.split('\n')) {
          // ': ping' é o heartbeat do servidor — comentário, não evento.
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length === 0) continue;

        try {
          const data = JSON.parse(dataLines.join('\n'));
          onEvent({ type: eventName as SSEEvent['type'], data } as SSEEvent);
        } catch (e) {
          console.warn('falha ao parsear evento SSE', eventName, e);
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

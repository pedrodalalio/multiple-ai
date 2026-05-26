import { useCallback, useRef, useState } from 'react';
import { streamChat, type SSEEvent } from '@/lib/api';
import type { LivePanel, LiveModelState } from '@/lib/types';

interface Options {
  modelos: string[];
  agregador: string;
  conversationId: string | null;
  mode?: 'auto' | 'single_fast' | 'panel_no_critique' | 'panel_full';
  onConversationCreated?: (id: string) => void;
  onDone?: (panel: LivePanel) => void;
}

function blankModel(id: string, label: string, provider: string): LiveModelState {
  return {
    model: id,
    label,
    provider,
    draft: '',
    draftStatus: 'pending',
    revision: '',
    critica: '',
    respostaRevisada: '',
    revisionStatus: 'pending',
  };
}

export function useChatStream() {
  const [live, setLive] = useState<LivePanel | null>(null);
  const [streaming, setStreaming] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const liveRef = useRef<LivePanel | null>(null);

  const cancel = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setLive(null);
    liveRef.current = null;
  }, []);

  const send = useCallback(async (prompt: string, opts: Options) => {
    if (streaming) return;
    setStreaming(true);
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;

    const initial: LivePanel = {
      conversationId: opts.conversationId ?? '',
      userMessageId: '',
      models: [],
      aggregatorId: opts.agregador,
      phase: 'idle',
      synthesis: '',
      synthesisModel: null,
      synthesisStatus: 'pending',
      synthesisError: null,
      synthesisFallbacks: [],
    };
    liveRef.current = initial;
    setLive(initial);

    const apply = (mut: (p: LivePanel) => LivePanel) => {
      const next = mut(liveRef.current!);
      liveRef.current = next;
      setLive(next);
    };

    try {
      await streamChat(
        {
          prompt,
          conversation_id: opts.conversationId ?? undefined,
          modelos: opts.modelos,
          agregador: opts.agregador,
          mode: opts.mode,
        },
        (ev: SSEEvent) => {
          switch (ev.type) {
            case 'meta': {
              const models = ev.data.panel.map((p) => blankModel(p.id, p.label, p.provider));
              apply((p) => ({
                ...p,
                conversationId: ev.data.conversation_id,
                userMessageId: ev.data.user_message_id,
                aggregatorId: ev.data.aggregator,
                models,
                mode: ev.data.mode,
                classified: ev.data.classified,
              }));
              if (!opts.conversationId) {
                opts.onConversationCreated?.(ev.data.conversation_id);
              }
              break;
            }
            case 'phase':
              apply((p) => ({
                ...p,
                phase: ev.data.phase,
                skipR2Reason: ev.data.phase === 'revisions' && ev.data.reason ? ev.data.reason : p.skipR2Reason,
              }));
              break;
            case 'similarity':
              apply((p) => ({
                ...p,
                similarity: ev.data.value,
                earlyExit: ev.data.earlyExit,
              }));
              break;
            case 'draft_start':
              apply((p) => ({
                ...p,
                models: p.models.map((m) =>
                  m.model === ev.data.model ? { ...m, draftStatus: 'streaming' } : m
                ),
              }));
              break;
            case 'draft_delta':
              apply((p) => ({
                ...p,
                models: p.models.map((m) =>
                  m.model === ev.data.model
                    ? { ...m, draft: m.draft + ev.data.delta, draftStatus: 'streaming' }
                    : m
                ),
              }));
              break;
            case 'draft_done':
              apply((p) => ({
                ...p,
                models: p.models.map((m) =>
                  m.model === ev.data.model
                    ? {
                        ...m,
                        draft: ev.data.texto || m.draft,
                        draftMs: ev.data.ms,
                        draftError: ev.data.erro,
                        draftTokensIn: ev.data.tokens_input,
                        draftTokensOut: ev.data.tokens_output,
                        draftStatus: ev.data.erro ? 'error' : 'done',
                      }
                    : m
                ),
              }));
              break;
            case 'revision_start':
              apply((p) => ({
                ...p,
                models: p.models.map((m) =>
                  m.model === ev.data.model ? { ...m, revisionStatus: 'streaming' } : m
                ),
              }));
              break;
            case 'revision_delta':
              apply((p) => ({
                ...p,
                models: p.models.map((m) =>
                  m.model === ev.data.model
                    ? {
                        ...m,
                        revision: m.revision + ev.data.delta,
                        revisionStatus: 'streaming',
                      }
                    : m
                ),
              }));
              break;
            case 'revision_done':
              apply((p) => ({
                ...p,
                models: p.models.map((m) =>
                  m.model === ev.data.model
                    ? {
                        ...m,
                        critica: ev.data.critica,
                        respostaRevisada: ev.data.resposta_revisada,
                        revision: ev.data.texto_bruto || m.revision,
                        revisionMs: ev.data.ms,
                        revisionError: ev.data.erro,
                        revisionStatus: ev.data.skipped
                          ? 'skipped'
                          : ev.data.erro
                            ? 'error'
                            : 'done',
                      }
                    : m
                ),
              }));
              break;
            case 'synthesis_start':
              apply((p) => ({
                ...p,
                synthesis: '',
                synthesisModel: ev.data.model,
                synthesisStatus: 'streaming',
              }));
              break;
            case 'synthesis_delta':
              apply((p) => ({
                ...p,
                synthesis: p.synthesis + ev.data.delta,
                synthesisModel: ev.data.model,
                synthesisStatus: 'streaming',
              }));
              break;
            case 'synthesis_done':
              apply((p) => ({
                ...p,
                synthesis: ev.data.texto || p.synthesis,
                synthesisModel: ev.data.model ?? p.synthesisModel,
                synthesisStatus: ev.data.erro ? 'error' : 'done',
                synthesisError: ev.data.erro,
              }));
              break;
            case 'synthesis_fallback':
              apply((p) => ({
                ...p,
                synthesisFallbacks: [
                  ...p.synthesisFallbacks,
                  { model: ev.data.model, erro: ev.data.erro },
                ],
              }));
              break;
            case 'done':
              apply((p) => ({
                ...p,
                phase: 'done',
                msTotal: ev.data.ms_total,
                assistantMessageId: ev.data.assistant_message_id ?? undefined,
                synthesisError: ev.data.synthesis_error ?? p.synthesisError,
              }));
              opts.onDone?.(liveRef.current!);
              break;
            case 'error':
              apply((p) => ({ ...p, phase: 'error', topLevelError: ev.data.error }));
              break;
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        apply((p) => ({
          ...p,
          phase: 'error',
          topLevelError: (err as Error).message,
        }));
      }
    } finally {
      setStreaming(false);
      ctrlRef.current = null;
    }
  }, [streaming]);

  return { live, streaming, send, cancel, reset };
}

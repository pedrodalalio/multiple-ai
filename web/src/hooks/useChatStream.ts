import { useCallback, useEffect, useRef, useState } from 'react';
import { streamChat, type SSEEvent } from '@/lib/api';
import type { ChatMode, LivePanel, LiveModelState } from '@/lib/types';

interface Options {
  modelos: string[];
  agregador: string;
  conversationId: string | null;
  mode?: ChatMode;
  onConversationCreated?: (id: string) => void;
  onDone?: (panel: LivePanel) => void;
}

/** Deltas acumulados entre dois flushes. */
interface Pending {
  drafts: Map<string, string>;
  revisions: Map<string, string>;
  synthesis: string;
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

const emptyPending = (): Pending => ({ drafts: new Map(), revisions: new Map(), synthesis: '' });

export function useChatStream() {
  const [live, setLive] = useState<LivePanel | null>(null);
  const [streaming, setStreaming] = useState(false);
  const ctrlRef = useRef<AbortController | null>(null);
  const liveRef = useRef<LivePanel | null>(null);

  // Deltas chegam token a token. Aplicar setState em cada um faz o React
  // rerenderizar (e o react-markdown reparsear) o painel inteiro por token —
  // com N modelos em paralelo isso domina o custo da UI. Acumulamos aqui e
  // damos um flush por frame.
  const pendingRef = useRef<Pending | null>(null);
  const frameRef = useRef<number | null>(null);

  const cancelFrame = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  }, []);

  useEffect(() => cancelFrame, [cancelFrame]);

  const cancel = useCallback(() => {
    ctrlRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    cancelFrame();
    pendingRef.current = null;
    liveRef.current = null;
    setLive(null);
  }, [cancelFrame]);

  const send = useCallback(
    async (prompt: string, opts: Options) => {
      if (ctrlRef.current) return; // já tem um stream em voo
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
      pendingRef.current = null;
      setLive(initial);

      /** Aplica os deltas acumulados sobre o painel. */
      const drain = (panel: LivePanel): LivePanel => {
        const pending = pendingRef.current;
        if (!pending) return panel;
        pendingRef.current = null;

        let next = panel;
        if (pending.drafts.size > 0 || pending.revisions.size > 0) {
          next = {
            ...next,
            models: next.models.map((m) => {
              const draft = pending.drafts.get(m.model);
              const revision = pending.revisions.get(m.model);
              if (!draft && !revision) return m;
              return {
                ...m,
                ...(draft ? { draft: m.draft + draft, draftStatus: 'streaming' as const } : null),
                ...(revision
                  ? { revision: m.revision + revision, revisionStatus: 'streaming' as const }
                  : null),
              };
            }),
          };
        }
        if (pending.synthesis) {
          next = {
            ...next,
            synthesis: next.synthesis + pending.synthesis,
            synthesisStatus: 'streaming',
          };
        }
        return next;
      };

      /** Eventos estruturais: drena o pendente primeiro pra preservar a ordem. */
      const apply = (mut: (p: LivePanel) => LivePanel) => {
        cancelFrame();
        const next = mut(drain(liveRef.current!));
        liveRef.current = next;
        setLive(next);
      };

      const queueFlush = () => {
        if (frameRef.current !== null) return;
        frameRef.current = requestAnimationFrame(() => {
          frameRef.current = null;
          if (!liveRef.current || !pendingRef.current) return;
          const next = drain(liveRef.current);
          liveRef.current = next;
          setLive(next);
        });
      };

      const pushDelta = (kind: 'drafts' | 'revisions', model: string, delta: string) => {
        const pending = (pendingRef.current ??= emptyPending());
        pending[kind].set(model, (pending[kind].get(model) ?? '') + delta);
        queueFlush();
      };

      /** Retry no servidor: descarta o texto parcial que já streamamos. */
      const resetModelText = (kind: 'draft' | 'revision', model: string) =>
        apply((p) => ({
          ...p,
          models: p.models.map((m) =>
            m.model === model ? { ...m, [kind]: '' } : m,
          ),
        }));

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
                if (!opts.conversationId) opts.onConversationCreated?.(ev.data.conversation_id);
                break;
              }
              case 'phase':
                apply((p) => ({
                  ...p,
                  phase: ev.data.phase,
                  skipR2Reason:
                    ev.data.phase === 'revisions' && ev.data.reason
                      ? ev.data.reason
                      : p.skipR2Reason,
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
                    m.model === ev.data.model ? { ...m, draftStatus: 'streaming' } : m,
                  ),
                }));
                break;
              case 'draft_delta':
                pushDelta('drafts', ev.data.model, ev.data.delta);
                break;
              case 'draft_reset':
                resetModelText('draft', ev.data.model);
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
                      : m,
                  ),
                }));
                break;

              case 'revision_start':
                apply((p) => ({
                  ...p,
                  models: p.models.map((m) =>
                    m.model === ev.data.model ? { ...m, revisionStatus: 'streaming' } : m,
                  ),
                }));
                break;
              case 'revision_delta':
                pushDelta('revisions', ev.data.model, ev.data.delta);
                break;
              case 'revision_reset':
                resetModelText('revision', ev.data.model);
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
                      : m,
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
              case 'synthesis_delta': {
                const pending = (pendingRef.current ??= emptyPending());
                pending.synthesis += ev.data.delta;
                queueFlush();
                break;
              }
              case 'synthesis_reset':
                apply((p) => ({ ...p, synthesis: '' }));
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
                // Passa o painel final: quem consome não deve depender do
                // `live` do render anterior, que ainda está desatualizado.
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
          apply((p) => ({ ...p, phase: 'error', topLevelError: (err as Error).message }));
        }
      } finally {
        cancelFrame();
        setStreaming(false);
        ctrlRef.current = null;
      }
    },
    [cancelFrame],
  );

  return { live, streaming, send, cancel, reset };
}

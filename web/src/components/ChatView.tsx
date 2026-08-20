import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Menu, Sparkles } from 'lucide-react';
import { Composer } from './Composer';
import { ModelPicker } from './ModelPicker';
import { PanelView } from './PanelView';
import { UserBubble } from './UserBubble';
import { useChatStream } from '@/hooks/useChatStream';
import type { ChatMode, ConversationDetail, LivePanel, ModelInfo, StoredMessage } from '@/lib/types';
import { fetchConversation } from '@/lib/api';
import { providerDotClass } from '@/lib/providers';
import { cn } from '@/lib/utils';

interface Props {
  conversationId: string | null;
  models: ModelInfo[];
  selectedModels: string[];
  aggregator: string;
  onPanelChange: (selected: string[], aggregator: string) => void;
  onConversationCreated: (id: string) => void;
  onConversationUpdated: () => void;
  onOpenSidebar: () => void;
}

const MODES: ChatMode[] = ['auto', 'single_fast', 'panel_no_critique', 'panel_full'];
const MODE_STORAGE_KEY = 'chat:mode';

function readStoredMode(): ChatMode {
  const saved = window.localStorage.getItem(MODE_STORAGE_KEY);
  return MODES.includes(saved as ChatMode) ? (saved as ChatMode) : 'auto';
}

function storedToLivePanel(message: StoredMessage, models: ModelInfo[]): LivePanel | null {
  if (!message.panel) return null;
  const p = message.panel;
  const rawMode = p.mode ?? null;
  const baseMode = rawMode?.split('+')[0];
  return {
    conversationId: '',
    userMessageId: '',
    aggregatorId: p.synthesis_model ?? '',
    phase: 'done',
    synthesis: p.synthesis_text ?? '',
    synthesisModel: p.synthesis_model,
    synthesisStatus: p.error ? 'error' : 'done',
    synthesisError: p.error,
    synthesisFallbacks: [],
    msTotal: p.ms_total,
    assistantMessageId: message.id,
    mode: baseMode ?? undefined,
    earlyExit: rawMode?.includes('early_exit') ?? false,
    cancelled: rawMode?.includes('cancelled') ?? false,
    models: p.drafts.map((d) => {
      const rev = p.revisions.find((r) => r.model === d.model);
      const info = models.find((m) => m.id === d.model);
      return {
        model: d.model,
        label: d.label ?? info?.label ?? d.model,
        provider: d.provider ?? info?.provider ?? '',
        draft: d.texto,
        draftStatus: d.erro ? 'error' : 'done',
        draftMs: d.ms,
        draftError: d.erro,
        draftTokensIn: d.tokens_input ?? null,
        draftTokensOut: d.tokens_output ?? null,
        revision: rev?.texto_bruto ?? rev?.texto ?? '',
        critica: rev?.critica ?? '',
        respostaRevisada: rev?.resposta_revisada ?? '',
        revisionStatus: rev?.erro ? (d.erro ? 'skipped' : 'error') : rev ? 'done' : 'skipped',
        revisionMs: rev?.ms,
        revisionError: rev?.erro ?? null,
      };
    }),
  };
}

export function ChatView({
  conversationId,
  models,
  selectedModels,
  aggregator,
  onPanelChange,
  onConversationCreated,
  onConversationUpdated,
  onOpenSidebar,
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [inFlightPrompt, setInFlightPrompt] = useState<string | null>(null);
  const [stored, setStored] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mode, setMode] = useState<ChatMode>(readStoredMode);

  useEffect(() => {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  const { live, streaming, send, cancel, reset } = useChatStream();
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastScrollRef = useRef(0);

  // Carrega a conversa quando o id muda.
  //
  // Não dá pra trocar isso por `key={conversationId}` no App (o jeito idiomático
  // de resetar estado): numa conversa nova o id chega no meio do stream, e o
  // remount mataria o AbortController e o painel em andamento.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      reset();
      setInFlightPrompt(null);
      setLoadError(null);
      if (!conversationId) {
        setStored(null);
        return;
      }
      setLoading(true);
      try {
        const detail = await fetchConversation(conversationId);
        if (!cancelled) setStored(detail);
      } catch (e) {
        if (cancelled) return;
        setStored(null);
        setLoadError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [conversationId, reset]);

  // Auto-scroll: `live` muda no máximo uma vez por frame, mas 'smooth' brigando
  // consigo mesmo trava a rolagem — throttle + comportamento instantâneo enquanto
  // streama, suave quando o turno acaba.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (!nearBottom) return;

    const now = Date.now();
    if (streaming && now - lastScrollRef.current < 250) return;
    lastScrollRef.current = now;
    el.scrollTo({ top: el.scrollHeight, behavior: streaming ? 'auto' : 'smooth' });
  }, [live, stored?.messages.length, inFlightPrompt, streaming]);

  const handleSubmit = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    setPrompt('');
    setInFlightPrompt(text);
    await send(text, {
      modelos: selectedModels,
      agregador: aggregator,
      conversationId,
      mode,
      onConversationCreated,
      onDone: async (panel) => {
        // O id vem do painel finalizado. Ler de `live` aqui pegaria o valor do
        // render em que o handler foi criado — null numa conversa nova.
        const id = conversationId ?? panel.conversationId ?? null;
        if (id) {
          const fresh = await fetchConversation(id).catch(() => null);
          if (fresh) setStored(fresh);
        }
        setInFlightPrompt(null);
        reset();
        onConversationUpdated();
      },
    });
  }, [
    prompt,
    send,
    selectedModels,
    aggregator,
    conversationId,
    mode,
    onConversationCreated,
    onConversationUpdated,
    reset,
  ]);

  const isEmpty = !conversationId && !live && !streaming && !inFlightPrompt;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b border-border bg-background/80 px-3 py-3 backdrop-blur sm:px-6">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <button
            type="button"
            onClick={onOpenSidebar}
            aria-label="Abrir lista de conversas"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          >
            <Menu className="h-4 w-4" />
          </button>
          <h1 className="truncate font-display text-lg text-foreground sm:text-xl">
            {stored?.conversation.title ?? (inFlightPrompt ? truncate(inFlightPrompt, 50) : 'Nova conversa')}
          </h1>
          {streaming && (
            <span
              role="status"
              className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary animate-pulse-soft"
            >
              <Sparkles className="h-2.5 w-2.5" />
              <span className="hidden sm:inline">ao vivo</span>
            </span>
          )}
        </div>
        <ModelPicker
          models={models}
          selected={selectedModels}
          aggregator={aggregator}
          onChange={onPanelChange}
          disabled={streaming}
        />
      </header>

      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {isEmpty ? (
          <EmptyState models={models} selected={selectedModels} />
        ) : (
          <div className="mx-auto max-w-5xl space-y-8 px-3 py-6 sm:px-6">
            {loading && <p className="text-center text-xs text-muted-foreground">carregando...</p>}
            {loadError && (
              <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-center text-xs text-destructive-foreground">
                {loadError}
              </p>
            )}

            {stored?.has_more && (
              <p className="text-center text-[11px] text-muted-foreground">
                mostrando as mensagens mais recentes desta conversa
              </p>
            )}
            {stored?.messages && renderStoredTurns(stored.messages, models)}

            {inFlightPrompt && <UserBubble content={inFlightPrompt} />}
            {live && <PanelView panel={live} defaultPanelOpen />}
          </div>
        )}
      </div>

      <footer className="border-t border-border bg-background/80 px-3 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto max-w-3xl">
          <Composer
            value={prompt}
            onChange={setPrompt}
            onSubmit={handleSubmit}
            onCancel={cancel}
            isStreaming={streaming}
            mode={mode}
            onModeChange={setMode}
          />
        </div>
      </footer>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function renderStoredTurns(messages: StoredMessage[], models: ModelInfo[]) {
  const out: ReactNode[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(<UserBubble key={m.id} content={m.content} />);
      continue;
    }
    const panel = storedToLivePanel(m, models);
    if (panel) {
      out.push(<PanelView key={m.id} panel={panel} defaultPanelOpen={false} />);
    } else {
      out.push(
        <div key={m.id} className="text-xs italic text-muted-foreground">
          {m.content}
        </div>,
      );
    }
  }
  return out;
}

function EmptyState({ models, selected }: { models: ModelInfo[]; selected: string[] }) {
  const active = models.filter((m) => selected.includes(m.id));
  return (
    <div className="dot-grid flex h-full items-center justify-center px-6 py-10">
      <div className="max-w-xl text-center">
        <div className="mx-auto mb-6 flex flex-wrap items-center justify-center gap-2">
          {active.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-1.5 rounded-full border border-border bg-card/80 px-3 py-1 text-[11px] backdrop-blur"
            >
              <span className={cn('h-1.5 w-1.5 rounded-full', providerDotClass(m.provider))} />
              {m.label}
            </div>
          ))}
        </div>
        <h2 className="text-balance font-display text-3xl text-foreground sm:text-4xl">
          Pergunte uma vez. <span className="italic text-primary">{active.length} cérebros</span> respondem,
          debatem entre si, e te entregam a melhor versão.
        </h2>
        <p className="mt-4 text-balance text-sm text-muted-foreground">
          Cada modelo escreve seu rascunho, lê o dos outros, critica o que viu,
          revisa sua própria resposta — e um agregador consolida tudo numa única resposta final.
        </p>
      </div>
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Composer } from './Composer';
import { ModelPicker } from './ModelPicker';
import { PanelView } from './PanelView';
import { UserBubble } from './UserBubble';
import { useChatStream } from '@/hooks/useChatStream';
import type { ChatMode, ConversationDetail, LivePanel, ModelInfo, StoredMessage } from '@/lib/types';
import { fetchConversation } from '@/lib/api';
import { providerDotClass } from './ProviderBadge';
import { cn } from '@/lib/utils';

interface Props {
  conversationId: string | null;
  models: ModelInfo[];
  selectedModels: string[];
  aggregator: string;
  onPanelChange: (selected: string[], aggregator: string) => void;
  onConversationCreated: (id: string) => void;
  onConversationUpdated: () => void;
}

function storedToLivePanel(message: StoredMessage, models: ModelInfo[]): LivePanel | null {
  if (!message.panel) return null;
  const p = message.panel;
  const rawMode = p.mode ?? null;
  const mode = rawMode && rawMode.startsWith('panel_full+early_exit') ? 'panel_full' : rawMode ?? undefined;
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
    mode: mode ?? undefined,
    earlyExit: rawMode?.includes('early_exit') ?? false,
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
}: Props) {
  const [prompt, setPrompt] = useState('');
  const [inFlightPrompt, setInFlightPrompt] = useState<string | null>(null);
  const [stored, setStored] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<ChatMode>(() => {
    if (typeof window === 'undefined') return 'auto';
    const saved = window.localStorage.getItem('chat:mode');
    return saved === 'auto' || saved === 'single_fast' || saved === 'panel_no_critique' || saved === 'panel_full'
      ? (saved as ChatMode)
      : 'auto';
  });

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('chat:mode', mode);
  }, [mode]);
  const { live, streaming, send, cancel, reset } = useChatStream();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Load conversation when id changes
  useEffect(() => {
    reset();
    setInFlightPrompt(null);
    if (!conversationId) {
      setStored(null);
      return;
    }
    setLoading(true);
    fetchConversation(conversationId)
      .then((d) => setStored(d))
      .catch(() => setStored(null))
      .finally(() => setLoading(false));
  }, [conversationId, reset]);

  // Auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (onBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [live?.synthesis, live?.models, stored?.messages.length, inFlightPrompt]);

  async function handleSubmit() {
    const text = prompt.trim();
    if (!text) return;
    setPrompt('');
    setInFlightPrompt(text);
    await send(text, {
      modelos: selectedModels,
      agregador: aggregator,
      conversationId,
      mode,
      onConversationCreated: (newId) => {
        onConversationCreated(newId);
      },
      onDone: async () => {
        // Reload the persisted conversation so the just-finished turn becomes history
        const id = conversationId ?? (live?.conversationId ?? null);
        const finalId = id ?? null;
        if (finalId) {
          const fresh = await fetchConversation(finalId).catch(() => null);
          if (fresh) setStored(fresh);
        }
        setInFlightPrompt(null);
        reset();
        onConversationUpdated();
      },
    });
  }

  const isEmpty = !conversationId && !live && !streaming && !inFlightPrompt;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-3 border-b border-border bg-background/80 px-6 py-3 backdrop-blur">
        <div className="flex min-w-0 items-center gap-3">
          <h1 className="truncate font-display text-xl text-foreground">
            {stored?.conversation.title ?? (inFlightPrompt ? truncate(inFlightPrompt, 50) : 'Nova conversa')}
          </h1>
          {streaming && (
            <span className="flex items-center gap-1.5 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary animate-pulse-soft">
              <Sparkles className="h-2.5 w-2.5" />
              ao vivo
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
          <div className="mx-auto max-w-5xl space-y-8 px-6 py-6">
            {loading && (
              <p className="text-center text-xs text-muted-foreground">carregando...</p>
            )}

            {stored?.messages && renderStoredTurns(stored.messages, models)}

            {inFlightPrompt && <UserBubble content={inFlightPrompt} />}
            {live && <PanelView panel={live} defaultPanelOpen />}
          </div>
        )}
      </div>

      <footer className="border-t border-border bg-background/80 px-6 py-3 backdrop-blur">
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
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function renderStoredTurns(messages: StoredMessage[], models: ModelInfo[]) {
  const out: React.ReactNode[] = [];
  for (const m of messages) {
    if (m.role === 'user') {
      out.push(<UserBubble key={m.id} content={m.content} />);
    } else {
      const live = storedToLivePanel(m, models);
      if (live) {
        out.push(<PanelView key={m.id} panel={live} defaultPanelOpen={false} />);
      } else {
        out.push(
          <div key={m.id} className="text-xs italic text-muted-foreground">
            {m.content}
          </div>
        );
      }
    }
  }
  return out;
}

function EmptyState({ models, selected }: { models: ModelInfo[]; selected: string[] }) {
  const active = models.filter((m) => selected.includes(m.id));
  return (
    <div className="dot-grid flex h-full items-center justify-center px-6">
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
        <h2 className="text-balance font-display text-4xl text-foreground">
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

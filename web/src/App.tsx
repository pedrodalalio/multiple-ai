import { useCallback, useEffect, useState } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import { deleteConversation, fetchConversations, fetchModels } from './lib/api';
import type { ConversationSummary, ModelInfo, UnavailableModel } from './lib/types';

export default function App() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [unavailable, setUnavailable] = useState<UnavailableModel[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [defaultAgg, setDefaultAgg] = useState<string>('');
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [aggregator, setAggregator] = useState<string>('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const refreshConversations = useCallback(() => {
    fetchConversations()
      .then((d) => {
        setConversations(d.conversations);
        setListError(null);
      })
      .catch((e: Error) => setListError(e.message));
  }, []);

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setUnavailable(m.unavailable ?? []);
        setDefaults(m.defaults);
        setDefaultAgg(m.default_aggregator);
        setSelectedModels(m.defaults);
        setAggregator(m.default_aggregator);
        if (m.models.length === 0) {
          setBootError('Nenhum modelo disponível — configure ao menos uma API key no .env do servidor.');
        }
      })
      .catch((e: Error) => setBootError(e.message));
    refreshConversations();
  }, [refreshConversations]);

  function handleNew() {
    setCurrentId(null);
    setSidebarOpen(false);
    if (defaults.length) {
      setSelectedModels(defaults);
      setAggregator(defaultAgg);
    }
  }

  function handleSelect(id: string) {
    setCurrentId(id);
    setSidebarOpen(false);
    const conv = conversations.find((c) => c.id === id);
    if (!conv) return;
    // Uma conversa antiga pode citar modelos que sumiram do registro ou ficaram
    // sem API key. Sem este filtro o próximo envio levaria 400 do backend.
    const known = new Set(models.map((m) => m.id));
    const panel = conv.panel.filter((id) => known.has(id));
    const effective = panel.length > 0 ? panel : defaults;
    setSelectedModels(effective);
    setAggregator(effective.includes(conv.aggregator) ? conv.aggregator : (effective[0] ?? defaultAgg));
  }

  async function handleDelete(id: string) {
    try {
      await deleteConversation(id);
      if (currentId === id) setCurrentId(null);
      refreshConversations();
    } catch (e) {
      setListError((e as Error).message);
    }
  }

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-6 sm:p-8">
        <div className="max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm">
          <p className="mb-2 font-semibold text-destructive">Não conseguiu conectar ao backend</p>
          <p className="text-muted-foreground">{bootError}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            Confirme que o servidor está rodando (<code className="rounded bg-muted px-1">pnpm start</code>) e
            que o proxy do Vite aponta pra ele.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar
        conversations={conversations}
        currentId={currentId}
        onSelect={handleSelect}
        onNew={handleNew}
        onDelete={handleDelete}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        error={listError}
        unavailable={unavailable}
      />
      <main className="min-w-0 flex-1 overflow-hidden">
        {models.length > 0 && aggregator && (
          <ChatView
            conversationId={currentId}
            models={models}
            selectedModels={selectedModels}
            aggregator={aggregator}
            onPanelChange={(sel, agg) => {
              setSelectedModels(sel);
              setAggregator(agg);
            }}
            onConversationCreated={(id) => {
              setCurrentId(id);
              refreshConversations();
            }}
            onConversationUpdated={refreshConversations}
            onOpenSidebar={() => setSidebarOpen(true)}
          />
        )}
      </main>
    </div>
  );
}

import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ChatView } from './components/ChatView';
import {
  deleteConversation,
  fetchConversations,
  fetchModels,
} from './lib/api';
import type { ConversationSummary, ModelInfo } from './lib/types';

export default function App() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [defaultAgg, setDefaultAgg] = useState<string>('');
  const [selectedModels, setSelectedModels] = useState<string[]>([]);
  const [aggregator, setAggregator] = useState<string>('');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);

  const refreshConversations = useCallback(() => {
    fetchConversations()
      .then((d) => setConversations(d.conversations))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchModels()
      .then((m) => {
        setModels(m.models);
        setDefaults(m.defaults);
        setDefaultAgg(m.default_aggregator);
        setSelectedModels(m.defaults);
        setAggregator(m.default_aggregator);
      })
      .catch((e) => setBootError(String(e)));
    refreshConversations();
  }, [refreshConversations]);

  function handleNew() {
    setCurrentId(null);
    if (defaults.length) {
      setSelectedModels(defaults);
      setAggregator(defaultAgg);
    }
  }

  function handleSelect(id: string) {
    setCurrentId(id);
    const conv = conversations.find((c) => c.id === id);
    if (conv) {
      setSelectedModels(conv.panel);
      setAggregator(conv.panel.includes(conv.aggregator) ? conv.aggregator : conv.panel[0] ?? defaultAgg);
    }
  }

  async function handleDelete(id: string) {
    await deleteConversation(id);
    if (currentId === id) setCurrentId(null);
    refreshConversations();
  }

  if (bootError) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-8">
        <div className="max-w-md rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-sm">
          <p className="mb-2 font-semibold text-destructive">Não conseguiu conectar ao backend</p>
          <p className="text-muted-foreground">{bootError}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            Confirme que o servidor está rodando (<code className="rounded bg-muted px-1">npm start</code>) e
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
      />
      <main className="flex-1 overflow-hidden">
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
          />
        )}
      </main>
    </div>
  );
}

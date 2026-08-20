import { useEffect } from 'react';
import { Plus, MessageSquare, Trash2, Layers, X, AlertTriangle } from 'lucide-react';
import type { ConversationSummary, UnavailableModel } from '@/lib/types';
import { cn, relativeTime } from '@/lib/utils';

interface Props {
  conversations: ConversationSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  /** Só afeta telas pequenas — em md+ a sidebar é sempre visível. */
  open: boolean;
  onClose: () => void;
  error?: string | null;
  unavailable?: UnavailableModel[];
}

export function Sidebar({
  conversations,
  currentId,
  onSelect,
  onNew,
  onDelete,
  open,
  onClose,
  error,
  unavailable = [],
}: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  return (
    <>
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 backdrop-blur-sm md:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}

      <aside
        aria-label="Conversas"
        className={cn(
          'z-40 flex h-full w-64 shrink-0 flex-col border-r border-border bg-card/95 backdrop-blur transition-transform md:relative md:translate-x-0 md:bg-card/40',
          'fixed inset-y-0 left-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/20 text-primary">
            <Layers className="h-4 w-4" />
          </div>
          <div className="flex flex-col leading-tight">
            <span className="font-display text-base text-foreground">Painel de IAs</span>
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">many-ais</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar lista de conversas"
            className="ml-auto rounded p-1 text-muted-foreground hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-2">
          <button
            type="button"
            onClick={onNew}
            className="flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Plus className="h-4 w-4" />
            Nova conversa
          </button>
        </div>

        {error && (
          <p className="mx-2 mb-2 rounded border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[10px] text-destructive-foreground">
            {error}
          </p>
        )}

        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 ? (
            <p className="px-3 py-8 text-center text-xs text-muted-foreground">
              Nenhuma conversa ainda.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {conversations.map((c) => (
                <li key={c.id}>
                  <div
                    className={cn(
                      'group flex items-center gap-2 rounded-md text-sm transition-colors',
                      currentId === c.id
                        ? 'bg-secondary/80 text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground',
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onSelect(c.id)}
                      aria-current={currentId === c.id ? 'true' : undefined}
                      className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs">{c.title}</span>
                        <span className="block text-[10px] text-muted-foreground/70">
                          {relativeTime(c.updated_at)} · {c.panel.length} modelo(s)
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(c.id)}
                      aria-label={`Excluir conversa "${c.title}"`}
                      title="Excluir"
                      className="mr-1 h-6 w-6 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/20 hover:text-destructive focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {unavailable.length > 0 && (
          <div className="border-t border-border px-4 py-2 text-[10px] text-amber-400/80">
            <p className="flex items-center gap-1.5 font-medium">
              <AlertTriangle className="h-3 w-3" />
              {unavailable.length} modelo(s) sem API key
            </p>
            <ul className="mt-1 space-y-0.5 text-muted-foreground">
              {unavailable.map((m) => (
                <li key={m.id} className="truncate" title={m.reason}>
                  {m.label}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
          3 rodadas · rascunho → crítica → síntese
        </div>
      </aside>
    </>
  );
}

import { Plus, MessageSquare, Trash2, Layers } from 'lucide-react';
import type { ConversationSummary } from '@/lib/types';
import { cn, relativeTime } from '@/lib/utils';

interface Props {
  conversations: ConversationSummary[];
  currentId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
}

export function Sidebar({ conversations, currentId, onSelect, onNew, onDelete }: Props) {
  return (
    <aside className="flex h-full w-64 shrink-0 flex-col border-r border-border bg-card/40">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/20 text-primary">
          <Layers className="h-4 w-4" />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="font-display text-base text-foreground">Painel de IAs</span>
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
            many-ais
          </span>
        </div>
      </div>

      <div className="p-2">
        <button
          onClick={onNew}
          className={cn(
            'flex w-full items-center gap-2 rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-foreground'
          )}
        >
          <Plus className="h-4 w-4" />
          Nova conversa
        </button>
      </div>

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
                    'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 text-sm transition-colors',
                    currentId === c.id
                      ? 'bg-secondary/80 text-foreground'
                      : 'text-muted-foreground hover:bg-secondary/40 hover:text-foreground'
                  )}
                  onClick={() => onSelect(c.id)}
                >
                  <MessageSquare className="h-3.5 w-3.5 shrink-0 opacity-60" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">{c.title}</p>
                    <p className="text-[10px] text-muted-foreground/70">
                      {relativeTime(c.updated_at)} · {c.panel.length} modelo(s)
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onDelete(c.id);
                    }}
                    className="invisible h-6 w-6 shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/20 hover:text-destructive group-hover:visible group-hover:opacity-100"
                    title="Excluir"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
        3 rodadas · rascunho → crítica → síntese
      </div>
    </aside>
  );
}

import { Loader2, CheckCircle2, XCircle, MinusCircle, Eye, EyeOff } from 'lucide-react';
import { useState } from 'react';
import { cn, formatMs } from '@/lib/utils';
import type { LiveModelState } from '@/lib/types';
import { providerDotClass } from './ProviderBadge';
import { MarkdownBody } from './MarkdownBody';

function StatusIcon({ status }: { status: LiveModelState['draftStatus'] | LiveModelState['revisionStatus'] }) {
  if (status === 'pending') return <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />;
  if (status === 'streaming') return <Loader2 className="h-3 w-3 animate-spin text-primary" />;
  if (status === 'done') return <CheckCircle2 className="h-3 w-3 text-emerald-400" />;
  if (status === 'error') return <XCircle className="h-3 w-3 text-destructive" />;
  if (status === 'skipped') return <MinusCircle className="h-3 w-3 text-muted-foreground" />;
  return null;
}

export function ModelColumn({ state }: { state: LiveModelState }) {
  const [view, setView] = useState<'draft' | 'revision'>('draft');
  const showStreamingCaret = (view === 'draft' && state.draftStatus === 'streaming')
    || (view === 'revision' && state.revisionStatus === 'streaming');

  const body =
    view === 'draft'
      ? state.draft
      : state.respostaRevisada || state.revision;

  const emptyMessage =
    view === 'draft'
      ? state.draftStatus === 'pending'
        ? 'aguardando...'
        : state.draftStatus === 'error'
          ? `erro: ${state.draftError ?? 'desconhecido'}`
          : ''
      : state.revisionStatus === 'pending'
        ? 'aguardando rodada de revisão...'
        : state.revisionStatus === 'skipped'
          ? 'pulou a revisão (rascunho falhou)'
          : state.revisionStatus === 'error'
            ? `erro: ${state.revisionError ?? 'desconhecido'}`
            : '';

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-card/60 backdrop-blur">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-secondary/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', providerDotClass(state.provider))} />
          <span className="truncate text-xs font-medium text-foreground">{state.label}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {state.draftMs != null && <span className="font-mono">{formatMs(state.draftMs)}</span>}
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-border/70 px-2 py-1.5">
        <button
          onClick={() => setView('draft')}
          className={cn(
            'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            view === 'draft' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <StatusIcon status={state.draftStatus} />
          rascunho
        </button>
        <button
          onClick={() => setView('revision')}
          className={cn(
            'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors',
            view === 'revision' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          <StatusIcon status={state.revisionStatus} />
          revisão
        </button>
        {view === 'revision' && state.critica && (
          <CritiqueToggle critica={state.critica} />
        )}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {body ? (
          <MarkdownBody streaming={showStreamingCaret}>{body}</MarkdownBody>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-muted-foreground italic">{emptyMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function CritiqueToggle({ critica }: { critica: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="ml-auto">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground"
      >
        {open ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        crítica
      </button>
      {open && (
        <div className="absolute right-4 z-10 mt-2 max-h-72 w-80 overflow-y-auto rounded-md border border-border bg-popover/95 p-3 shadow-lg backdrop-blur">
          <MarkdownBody className="prose-xs">{critica}</MarkdownBody>
        </div>
      )}
    </div>
  );
}

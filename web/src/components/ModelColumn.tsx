import { memo, useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle2, XCircle, MinusCircle, Eye, EyeOff } from 'lucide-react';
import { cn, formatMs } from '@/lib/utils';
import type { LiveModelState } from '@/lib/types';
import { providerDotClass } from '@/lib/providers';
import { MarkdownBody } from './MarkdownBody';

type Status = LiveModelState['draftStatus'] | LiveModelState['revisionStatus'];

const STATUS_LABEL: Record<Status, string> = {
  pending: 'aguardando',
  streaming: 'em andamento',
  done: 'concluído',
  error: 'erro',
  skipped: 'pulado',
};

function StatusIcon({ status }: { status: Status }) {
  const label = STATUS_LABEL[status];
  if (status === 'pending')
    return <span role="img" aria-label={label} className="h-2 w-2 rounded-full bg-muted-foreground/30" />;
  if (status === 'streaming')
    return <Loader2 aria-label={label} className="h-3 w-3 animate-spin text-primary" />;
  if (status === 'done')
    return <CheckCircle2 aria-label={label} className="h-3 w-3 text-emerald-400" />;
  if (status === 'error') return <XCircle aria-label={label} className="h-3 w-3 text-destructive" />;
  return <MinusCircle aria-label={label} className="h-3 w-3 text-muted-foreground" />;
}

function emptyMessageFor(state: LiveModelState, view: 'draft' | 'revision') {
  if (view === 'draft') {
    if (state.draftStatus === 'pending') return 'aguardando...';
    if (state.draftStatus === 'error') return `erro: ${state.draftError ?? 'desconhecido'}`;
    return '';
  }
  if (state.revisionStatus === 'pending') return 'aguardando rodada de revisão...';
  if (state.revisionStatus === 'skipped') return 'pulou a revisão';
  if (state.revisionStatus === 'error') return `erro: ${state.revisionError ?? 'desconhecido'}`;
  return '';
}

function ModelColumnImpl({ state }: { state: LiveModelState }) {
  const [view, setView] = useState<'draft' | 'revision'>('draft');

  const showCaret =
    (view === 'draft' && state.draftStatus === 'streaming') ||
    (view === 'revision' && state.revisionStatus === 'streaming');
  const body = view === 'draft' ? state.draft : state.respostaRevisada || state.revision;
  const emptyMessage = emptyMessageFor(state, view);

  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card/60 backdrop-blur">
      <div className="flex items-center justify-between gap-2 border-b border-border/70 bg-secondary/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', providerDotClass(state.provider))} />
          <span className="truncate text-xs font-medium text-foreground">{state.label}</span>
        </div>
        {state.draftMs != null && (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
            {formatMs(state.draftMs)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-1 border-b border-border/70 px-2 py-1.5">
        <TabButton active={view === 'draft'} onClick={() => setView('draft')}>
          <StatusIcon status={state.draftStatus} />
          rascunho
        </TabButton>
        <TabButton active={view === 'revision'} onClick={() => setView('revision')}>
          <StatusIcon status={state.revisionStatus} />
          revisão
        </TabButton>
        {view === 'revision' && state.critica && <CritiqueToggle critica={state.critica} />}
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3">
        {body ? (
          <MarkdownBody streaming={showCaret}>{body}</MarkdownBody>
        ) : (
          <div className="flex h-full items-center justify-center">
            <p className="text-center text-xs italic text-muted-foreground">{emptyMessage}</p>
          </div>
        )}
      </div>
    </div>
  );
}

// Só rerenderiza a coluna cujo estado mudou — sem isto, um delta de qualquer
// modelo rerenderiza (e reparseia o markdown de) todas as colunas do painel.
export const ModelColumn = memo(ModelColumnImpl);

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        active ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function CritiqueToggle({ critica }: { critica: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // `relative` aqui é o que ancora o popup: sem um ancestral posicionado, o
  // `absolute` abaixo se prendia a um elemento arbitrário mais acima na árvore.
  return (
    <div ref={ref} className="relative ml-auto">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-1 rounded px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {open ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
        crítica
      </button>
      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 max-h-72 w-72 max-w-[80vw] overflow-y-auto rounded-md border border-border bg-popover/95 p-3 text-popover-foreground shadow-lg backdrop-blur sm:w-80">
          <MarkdownBody className="text-[11px]">{critica}</MarkdownBody>
        </div>
      )}
    </div>
  );
}

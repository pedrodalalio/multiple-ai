import { Check, Settings2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ModelInfo } from '@/lib/types';
import { cn } from '@/lib/utils';
import { providerDotClass } from '@/lib/providers';

interface Props {
  models: ModelInfo[];
  selected: string[];
  aggregator: string;
  onChange: (selected: string[], aggregator: string) => void;
  disabled?: boolean;
}

export function ModelPicker({ models, selected, aggregator, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Derivado, não sincronizado por efeito: se o picker for desabilitado no meio
  // de um stream, o dropdown some sem precisar de um setState em cascata.
  const isOpen = open && !disabled;

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [isOpen]);

  function togglePanel(id: string) {
    if (!selected.includes(id)) {
      onChange([...selected, id], aggregator);
      return;
    }
    if (selected.length === 1) return; // mantém pelo menos 1
    const next = selected.filter((x) => x !== id);
    onChange(next, aggregator === id ? next[0] : aggregator);
  }

  function setAgg(id: string) {
    if (selected.includes(id)) onChange(selected, id);
    else onChange([...selected, id], id);
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={`Escolher modelos do painel (${selected.length} selecionado(s))`}
        className="flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="hidden text-muted-foreground sm:inline">painel:</span>
        <span className="font-mono text-foreground">{selected.length}</span>
        <span className="flex items-center gap-0.5">
          {selected.map((id) => (
            <span
              key={id}
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                providerDotClass(models.find((x) => x.id === id)?.provider ?? ''),
              )}
            />
          ))}
        </span>
      </button>

      {isOpen && (
        <div
          role="dialog"
          aria-label="Modelos no painel"
          className="absolute right-0 top-full z-30 mt-2 w-[min(20rem,calc(100vw-1.5rem))] rounded-lg border border-border bg-popover/95 p-2 text-popover-foreground shadow-xl backdrop-blur animate-fade-in"
        >
          <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Modelos no painel
          </p>
          <div className="space-y-0.5">
            {models.map((m) => {
              const isSel = selected.includes(m.id);
              const isAgg = aggregator === m.id;
              const lastOne = isSel && selected.length === 1;
              return (
                <div
                  key={m.id}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                    isSel ? 'bg-secondary/60' : 'hover:bg-secondary/30',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => togglePanel(m.id)}
                    disabled={lastOne}
                    role="checkbox"
                    aria-checked={isSel}
                    title={lastOne ? 'O painel precisa de pelo menos um modelo' : undefined}
                    className="flex flex-1 items-center gap-2 rounded text-left disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                        isSel ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                      )}
                    >
                      {isSel && <Check className="h-3 w-3" />}
                    </span>
                    <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', providerDotClass(m.provider))} />
                    <span className="flex-1 truncate">{m.label}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setAgg(m.id)}
                    aria-pressed={isAgg}
                    title="Definir como agregador (faz a síntese final)"
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isAgg ? 'bg-primary/20 text-primary' : 'text-muted-foreground/60 hover:text-foreground',
                    )}
                  >
                    {isAgg ? '✓ agregador' : 'agregador?'}
                  </button>
                </div>
              );
            })}
          </div>
          <p className="mt-2 border-t border-border px-2 py-1.5 text-[10px] text-muted-foreground">
            O agregador faz a síntese final. Tem que estar no painel.
          </p>
        </div>
      )}
    </div>
  );
}

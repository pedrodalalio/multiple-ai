import { Check, Settings2 } from 'lucide-react';
import { useState, useRef, useEffect } from 'react';
import type { ModelInfo } from '@/lib/types';
import { cn } from '@/lib/utils';
import { providerDotClass } from './ProviderBadge';

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

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  function togglePanel(id: string) {
    if (selected.includes(id)) {
      if (selected.length === 1) return; // keep at least 1
      const next = selected.filter((x) => x !== id);
      const nextAgg = aggregator === id ? next[0] : aggregator;
      onChange(next, nextAgg);
    } else {
      onChange([...selected, id], aggregator);
    }
  }

  function setAgg(id: string) {
    if (!selected.includes(id)) onChange([...selected, id], id);
    else onChange(selected, id);
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        className={cn(
          'flex items-center gap-2 rounded-md border border-border bg-card/50 px-3 py-1.5 text-xs hover:bg-secondary disabled:opacity-50'
        )}
      >
        <Settings2 className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-muted-foreground">painel:</span>
        <span className="font-mono text-foreground">{selected.length}</span>
        <div className="flex items-center gap-0.5">
          {selected.map((id) => {
            const m = models.find((x) => x.id === id);
            return (
              <span
                key={id}
                className={cn('h-1.5 w-1.5 rounded-full', providerDotClass(m?.provider ?? ''))}
              />
            );
          })}
        </div>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-lg border border-border bg-popover/95 p-2 shadow-xl backdrop-blur animate-fade-in">
          <p className="px-2 py-1 text-[10px] uppercase tracking-wider text-muted-foreground">
            Modelos no painel
          </p>
          <div className="space-y-0.5">
            {models.map((m) => {
              const isSel = selected.includes(m.id);
              const isAgg = aggregator === m.id;
              return (
                <div
                  key={m.id}
                  className={cn(
                    'flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors',
                    isSel ? 'bg-secondary/60' : 'hover:bg-secondary/30'
                  )}
                >
                  <button
                    onClick={() => togglePanel(m.id)}
                    className="flex flex-1 items-center gap-2 text-left"
                  >
                    <span
                      className={cn(
                        'flex h-4 w-4 items-center justify-center rounded border',
                        isSel
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-border'
                      )}
                    >
                      {isSel && <Check className="h-3 w-3" />}
                    </span>
                    <span className={cn('h-1.5 w-1.5 rounded-full', providerDotClass(m.provider))} />
                    <span className="flex-1 truncate">{m.label}</span>
                  </button>
                  <button
                    onClick={() => setAgg(m.id)}
                    className={cn(
                      'rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider transition-colors',
                      isAgg
                        ? 'bg-primary/20 text-primary'
                        : 'text-muted-foreground/60 hover:text-foreground'
                    )}
                    title="Definir como agregador (faz a síntese final)"
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

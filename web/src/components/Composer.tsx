import { useEffect, useRef } from 'react';
import { ArrowUp, Square, Zap } from 'lucide-react';
import { Button } from './ui/Button';
import { Textarea } from './ui/Textarea';
import { cn } from '@/lib/utils';
import type { ChatMode } from '@/lib/types';

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  isStreaming: boolean;
  disabled?: boolean;
  placeholder?: string;
  mode?: ChatMode;
  onModeChange?: (mode: ChatMode) => void;
}

const MODE_CYCLE: ChatMode[] = ['auto', 'single_fast', 'panel_no_critique', 'panel_full'];
const MODE_LABEL: Record<ChatMode, string> = {
  auto: 'auto',
  single_fast: 'rápido',
  panel_no_critique: 'painel',
  panel_full: 'painel+rev',
};
const MODE_HINT: Record<ChatMode, string> = {
  auto: 'detecta automaticamente (recomendado)',
  single_fast: '1 modelo só — mais rápido e mais barato, ideal para código',
  panel_no_critique: 'painel paralelo sem rodada de crítica',
  panel_full: 'painel completo com crítica e revisão',
};

export function Composer({ value, onChange, onSubmit, onCancel, isStreaming, disabled, placeholder, mode, onModeChange }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const currentMode: ChatMode = mode ?? 'auto';

  function cycleMode() {
    if (!onModeChange) return;
    const idx = MODE_CYCLE.indexOf(currentMode);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    onModeChange(next);
  }

  // Autosize
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 280) + 'px';
  }, [value]);

  const canSend = value.trim().length > 0 && !isStreaming && !disabled;

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSubmit();
    }
  }

  return (
    <div className="relative">
      <div
        className={cn(
          'flex items-end gap-2 rounded-2xl border bg-card/80 p-2 shadow-lg backdrop-blur transition-colors',
          'focus-within:border-primary/60 focus-within:shadow-primary/20'
        )}
      >
        <Textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? 'Pergunte algo ao painel...'}
          aria-label="Mensagem para o painel"
          disabled={disabled}
          className="min-h-[40px] max-h-[280px] flex-1"
        />
        {isStreaming ? (
          <Button
            type="button"
            size="icon"
            variant="destructive"
            onClick={onCancel}
            className="shrink-0 rounded-full"
            title="Cancelar"
          >
            <Square className="h-4 w-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            onClick={onSubmit}
            disabled={!canSend}
            className="shrink-0 rounded-full"
            title="Enviar (Enter)"
          >
            <ArrowUp className="h-4 w-4" />
          </Button>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-between px-3 text-[10px] text-muted-foreground">
        <span className="hidden sm:inline">Enter para enviar · Shift+Enter quebra linha</span>
        <span className="sm:hidden" />
        {onModeChange && (
          <button
            type="button"
            onClick={cycleMode}
            disabled={isStreaming}
            title={MODE_HINT[currentMode]}
            aria-label={`Modo de execução: ${MODE_LABEL[currentMode]}. ${MODE_HINT[currentMode]}. Clique para alternar.`}
            className={cn(
              'flex items-center gap-1 rounded-full border border-border px-2 py-0.5 transition-colors hover:border-primary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
              currentMode !== 'auto' && 'border-primary/40 text-primary'
            )}
          >
            <Zap className="h-2.5 w-2.5" />
            modo: <span className="font-medium">{MODE_LABEL[currentMode]}</span>
          </button>
        )}
      </div>
    </div>
  );
}

import { memo, useState } from 'react';
import { Sparkles, Loader2, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { cn, formatMs } from '@/lib/utils';
import type { LivePanel } from '@/lib/types';
import { ModelColumn } from './ModelColumn';
import { MarkdownBody } from './MarkdownBody';
import { providerDotClass } from '@/lib/providers';

const MODE_LABELS: Record<string, string> = {
  single_fast: 'rápido (1 modelo)',
  panel_no_critique: 'painel s/ crítica',
  panel_full: 'painel completo',
};

function PanelViewImpl({
  panel,
  defaultPanelOpen = true,
}: {
  panel: LivePanel;
  defaultPanelOpen?: boolean;
}) {
  const [panelOpen, setPanelOpen] = useState(defaultPanelOpen);
  const isLive = panel.phase !== 'done' && panel.phase !== 'error';
  const hasSynth = panel.synthesis.length > 0 || panel.synthesisStatus === 'streaming';
  const modeLabel = panel.mode ? (MODE_LABELS[panel.mode] ?? panel.mode) : null;

  return (
    <div className="space-y-3">
      {/* Trilha de fases */}
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <PhasePill
          label="rascunhos"
          active={panel.phase === 'drafts'}
          done={panel.phase !== 'drafts' && panel.phase !== 'idle'}
        />
        <span aria-hidden className="text-muted-foreground/40">→</span>
        <PhasePill
          label="crítica + revisão"
          active={panel.phase === 'revisions'}
          done={panel.phase === 'synthesis' || panel.phase === 'done'}
        />
        <span aria-hidden className="text-muted-foreground/40">→</span>
        <PhasePill label="síntese" active={panel.phase === 'synthesis'} done={panel.phase === 'done'} />

        <div className="ml-auto flex items-center gap-2">
          {panel.cancelled && (
            <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-amber-400/90">
              cancelado
            </span>
          )}
          {modeLabel && (
            <span
              className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] uppercase tracking-wider"
              title={
                panel.similarity != null
                  ? `similaridade entre rascunhos: ${panel.similarity.toFixed(2)}${panel.earlyExit ? ' (early-exit)' : ''}`
                  : undefined
              }
            >
              {modeLabel}
              {panel.earlyExit && ' · early-exit'}
            </span>
          )}
          {panel.msTotal != null && (
            <span className="font-mono text-[10px]">total {formatMs(panel.msTotal)}</span>
          )}
          <button
            type="button"
            onClick={() => setPanelOpen((o) => !o)}
            aria-expanded={panelOpen}
            className="flex items-center gap-1 rounded text-[11px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {panelOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            painel
          </button>
        </div>
      </div>

      {/* Colunas dos modelos — auto-fit empilha sozinho em telas estreitas,
          em vez de espremer N colunas fixas num celular. */}
      {panelOpen && (
        <div
          className="grid animate-fade-in gap-3"
          style={{
            gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 15rem), 1fr))',
            minHeight: '280px',
          }}
        >
          {panel.models.map((m) => (
            <ModelColumn key={m.model} state={m} />
          ))}
        </div>
      )}

      {/* Síntese */}
      <div
        className={cn(
          'rounded-xl border bg-gradient-to-br from-primary/10 via-card to-card p-4 transition-all sm:p-5',
          hasSynth || isLive
            ? 'border-primary/40 shadow-[0_0_60px_-30px] shadow-primary/50'
            : 'border-border',
        )}
      >
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-primary">
            {panel.synthesisStatus === 'streaming' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            síntese
            {panel.synthesisModel && (
              <span className="ml-2 flex items-center gap-1.5 text-[10px] font-normal normal-case text-muted-foreground">
                <span
                  className={cn(
                    'h-1.5 w-1.5 rounded-full',
                    providerDotClass(modelProvider(panel, panel.synthesisModel)),
                  )}
                />
                via {modelLabel(panel, panel.synthesisModel)}
              </span>
            )}
          </div>
          {panel.synthesisFallbacks.length > 0 && (
            <span className="text-[10px] text-amber-400/80">
              {panel.synthesisFallbacks.length} agregador(es) falharam, caiu pro próximo
            </span>
          )}
        </div>

        {panel.synthesisError && !panel.synthesis ? (
          <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="min-w-0">
              <p className="font-medium">Síntese falhou</p>
              <p className="break-words text-xs text-destructive-foreground/80">{panel.synthesisError}</p>
            </div>
          </div>
        ) : (
          <MarkdownBody streaming={panel.synthesisStatus === 'streaming'}>
            {panel.synthesis || (panel.phase === 'synthesis' ? '' : '...')}
          </MarkdownBody>
        )}
      </div>
    </div>
  );
}

// Turnos já persistidos nunca mudam; sem memo eles rerenderizam a cada token
// do turno em andamento.
export const PanelView = memo(PanelViewImpl);

function PhasePill({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors',
        active
          ? 'bg-primary/15 text-primary animate-pulse-soft'
          : done
            ? 'bg-emerald-500/10 text-emerald-400'
            : 'bg-muted text-muted-foreground',
      )}
    >
      {active && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {label}
    </span>
  );
}

function modelLabel(panel: LivePanel, modelId: string): string {
  return panel.models.find((x) => x.model === modelId)?.label ?? modelId;
}

function modelProvider(panel: LivePanel, modelId: string): string {
  return panel.models.find((x) => x.model === modelId)?.provider ?? '';
}

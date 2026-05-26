import { cn } from '@/lib/utils';

const PROVIDER_COLOR: Record<string, string> = {
  google: 'bg-google/15 text-google border-google/30',
  groq: 'bg-groq/15 text-groq border-groq/30',
  mistral: 'bg-mistral/15 text-mistral border-mistral/30',
};

const PROVIDER_DOT: Record<string, string> = {
  google: 'bg-google',
  groq: 'bg-groq',
  mistral: 'bg-mistral',
};

export function providerDotClass(provider: string) {
  return PROVIDER_DOT[provider] ?? 'bg-muted-foreground';
}

export function providerChipClass(provider: string) {
  return PROVIDER_COLOR[provider] ?? 'bg-muted text-muted-foreground border-border';
}

export function ProviderBadge({ provider, label }: { provider: string; label?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider',
        providerChipClass(provider)
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', providerDotClass(provider))} />
      {label ?? provider}
    </span>
  );
}

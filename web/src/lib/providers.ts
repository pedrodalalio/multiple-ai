// Cores por provider. Fica em lib/ (e não junto de um componente) pra não
// misturar exports de componente e de helper no mesmo módulo — isso quebra o
// fast refresh do Vite.
const PROVIDER_DOT: Record<string, string> = {
  google: 'bg-google',
  groq: 'bg-groq',
  mistral: 'bg-mistral',
};

export function providerDotClass(provider: string): string {
  return PROVIDER_DOT[provider] ?? 'bg-muted-foreground';
}

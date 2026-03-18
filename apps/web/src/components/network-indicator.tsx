'use client';

function getNetworkLabel(): string {
  if (typeof process === 'undefined') return 'Stacks';
  const raw = (process.env.NEXT_PUBLIC_STACKS_NETWORK ?? 'mainnet').toLowerCase();
  if (raw === 'testnet') return 'Stacks testnet';
  if (raw === 'mainnet') return 'Stacks mainnet';
  return `Stacks (${raw})`;
}

export function NetworkIndicator() {
  const label = getNetworkLabel();

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-1.5 text-xs">
      <span
        className="relative flex size-2"
        aria-hidden
      >
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-500 opacity-75" />
        <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
      </span>
      <span className="font-medium text-foreground">{label}</span>
    </div>
  );
}

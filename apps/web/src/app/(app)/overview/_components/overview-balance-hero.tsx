'use client';

import { useState } from 'react';
import { ArrowUpRight, ArrowDownLeft, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatUsd } from '@/lib/format';
import { SendModal } from '@/app/(app)/dashboard/_components/send-modal';
import { ReceiveModal } from '@/app/(app)/dashboard/_components/receive-modal';
import { usePortfolio } from '@/hooks/use-portfolio';
import { useYieldPositions } from '@/hooks/use-yield-agent';
import { useAgentStatus } from '@/hooks/use-agent';
import { useYieldAgentStatus } from '@/hooks/use-yield-agent';

const isLpToken = (symbol: string) => /VAULT|LP|UNIV3/i.test(symbol);

export function OverviewBalanceHero() {
  const [sendOpen, setSendOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);

  const { data: fxData, isLoading: fxLoading } = usePortfolio('fx');
  const { data: yieldData, isLoading: yieldLoading } = usePortfolio('yield');
  const { data: yieldPositionsData } = useYieldPositions();
  const { data: fxAgent } = useAgentStatus();
  const { data: yieldAgent } = useYieldAgentStatus();

  // Total = FX total + Yield total (each portfolio already includes its own vault tokens)
  const fxTotal = fxData?.totalValueUsd ?? 0;
  const yieldTotal = yieldData?.totalValueUsd ?? 0;
  const totalBalance = fxTotal + yieldTotal;
  const fxBalance = fxTotal;
  const yieldBalance = yieldTotal;

  // Debug logging to understand any discrepancies in totals
  // Primary wallet for Receive: FX if available, else Yield
  const primaryWalletAddress =
    fxAgent?.config.serverWalletAddress ??
    yieldAgent?.config.serverWalletAddress ??
    '';

  const fxHoldings = fxData?.holdings ?? [];
  const isLoading = fxLoading || yieldLoading;

  if (isLoading) {
    return (
      <Card className="flex flex-col gap-6 border-border/50 bg-card p-6 shadow-sm dark:bg-[#18181b] lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="flex gap-3">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-10 w-24" />
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card className="flex flex-col gap-6 border-border/50 bg-card p-6 shadow-sm dark:bg-[#18181b] lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Wallet className="size-4" />
            <span>Total Portfolio Balance</span>
          </div>
          <div className="flex items-baseline gap-4">
            <h1 className="font-mono text-4xl font-bold tracking-tight text-foreground">
              {formatUsd(totalBalance)}
            </h1>
          </div>
          <div className="flex gap-4 text-xs text-muted-foreground">
            <span>FX: {formatUsd(fxBalance)}</span>
            <span>Yield: {formatUsd(yieldBalance)}</span>
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            size="lg"
            className="flex-1 gap-2 lg:flex-none"
            onClick={() => setReceiveOpen(true)}
            disabled={!primaryWalletAddress}
          >
            <ArrowDownLeft className="size-4" />
            Receive Funds
          </Button>
          <Button
            variant="outline"
            size="lg"
            className="flex-1 gap-2 lg:flex-none"
            onClick={() => setSendOpen(true)}
            disabled={!primaryWalletAddress}
          >
            <ArrowUpRight className="size-4" />
            Send
          </Button>
        </div>
      </Card>

      <SendModal
        open={sendOpen}
        onOpenChange={setSendOpen}
        holdings={fxHoldings}
        agentType="fx"
      />
      <ReceiveModal
        open={receiveOpen}
        onOpenChange={setReceiveOpen}
        walletAddress={primaryWalletAddress || '0x0'}
      />
    </>
  );
}

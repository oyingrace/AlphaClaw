'use client';

import { Suspense, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import { useMotionSafe } from '@/lib/motion';
import { Sprout } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { CardSpotlight } from '@/components/ui/card-spotlight';
import { useYieldAgentStatus, useSyncYieldPositions } from '@/hooks/use-yield-agent';
import { YieldAgentDashboard } from './yield-agent-dashboard';

/* ------------------------------------------------------------------ */
/*  Hero CTA for unregistered users                                    */
/* ------------------------------------------------------------------ */

function YieldHero() {
  const m = useMotionSafe();
  const router = useRouter();

  const features = [
    {
      title: 'High-Yield Opportunities',
      desc: 'Discovers the best yield on Stacks — stSTX liquid staking, native stacking, USDCx/sBTC and more.',
      tags: ['stSTX', 'Stacking', 'USDCx'],
    },
    {
      title: 'Auto-Rebalancing',
      desc: 'Continuously monitors APRs and rotates into higher-yielding positions.',
      tags: ['APR', '24/7', 'AUTO'],
    },
    {
      title: 'Reward Claiming',
      desc: 'Tracks rewards and can auto-compound when automated execution is enabled.',
      tags: ['Stacks', 'Compound'],
    },
  ];

  return (
    <motion.div
      {...m.fadeIn}
      transition={{ duration: m.duration.normal }}
      className="space-y-8"
    >
      <div className="text-center">
        <div className="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
          <Sprout className="size-7 text-primary" />
        </div>
        <h1 className="text-2xl font-bold">Yield Farming Agent</h1>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground leading-relaxed">
          Put your stablecoins to work. The yield agent automatically deposits
          into the highest-APR opportunities on Stacks and manages your positions 24/7.
        </p>
      </div>

      <div className="flex justify-center">
        <Button
          size="lg"
          className="gap-2"
          onClick={() => router.push('/onboarding?agent=yield')}
        >
          <Sprout className="size-4" />
          Create Yield Agent
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        {features.map((f) => (
          <CardSpotlight
            key={f.title}
            color="rgba(251, 191, 36, 0.12)"
            radius={280}
          >
            <div className="flex flex-col items-center p-6 text-center">
              <p className="text-sm font-semibold">{f.title}</p>
              <p className="mt-2 text-xs text-muted-foreground leading-relaxed">
                {f.desc}
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {f.tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-border/60 bg-muted/50 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          </CardSpotlight>
        ))}
      </div>
    </motion.div>
  );
}

function YieldAgentWrapper() {
  const { data, isLoading, isError } = useYieldAgentStatus();
  const router = useRouter();

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="text-center">
          <Skeleton className="mx-auto h-7 w-48" />
          <Skeleton className="mx-auto mt-2 h-4 w-72" />
        </div>
        <Card>
          <CardContent className="space-y-4 p-6">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-64" />
            <div className="flex gap-3">
              <Skeleton className="h-9 w-24" />
              <Skeleton className="h-9 w-24" />
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // No yield agent registered — show hero CTA
  if (!data || isError) {
    return <YieldHero />;
  }

  return (
      <div className="space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">Yield Farming Agent</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            Autonomous yield farming on Stacks — deposits into top opportunities and manages
            positions 24/7.
          </p>
        </div>

        <YieldAgentDashboard />
      </div>
  );
}

export function YieldAgentContent() {
  const syncPositions = useSyncYieldPositions();

  // Sync positions from chain once per visit (backfills for pre-tracking deposits)
  useEffect(() => {
    syncPositions.mutate(undefined, {
      onError: () => {
        // Ignore 404 (yield agent not configured) and other errors
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, []);

  return (
    <Suspense>
      <YieldAgentWrapper />
    </Suspense>
  );
}

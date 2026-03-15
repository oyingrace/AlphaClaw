import { ExternalLink, Vote } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface GovernanceData {
  markdown: string;
  url: string;
  scrapedAt: string;
  error?: string;
}

export function GovernanceCard({ data }: { data: GovernanceData }) {
  if (!data) return null;

  if (data.error) {
    return (
      <Card className="w-full max-w-md bg-rose-950/20 border-rose-900/50">
        <CardContent className="pt-4 text-sm text-rose-400">
          Failed to fetch governance data: {data.error}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md bg-zinc-900/50 border-zinc-800">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-zinc-200 flex items-center gap-2">
          <Vote className="h-4 w-4 text-primary" />
          Governance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <div className="text-sm text-zinc-400">
          Governance integrations are not available in the current Stacks-only release.
        </div>
      </CardContent>
    </Card>
  );
}

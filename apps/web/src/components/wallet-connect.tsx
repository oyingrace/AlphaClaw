'use client';

import { useState } from 'react';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { connectStacksAndLogin } from '@/lib/stacks-connect';
import { disconnect } from '@stacks/connect';
import { toast } from 'sonner';
import { LogIn, LogOut } from 'lucide-react';
import { shortenAddress } from '@/lib/format';

export function WalletConnect() {
  const { isAuthenticated, walletAddress, handleLogin, handleLogout } = useAuth();
  const [loading, setLoading] = useState(false);

  const onConnect = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const { address, jwt } = await connectStacksAndLogin();
      await handleLogin(jwt, address);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to connect wallet';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  const onDisconnect = async () => {
    try {
      disconnect();
      await handleLogout();
    } catch {
      await handleLogout();
    }
  };

  if (isAuthenticated && walletAddress) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="!w-full justify-center gap-2 font-mono text-xs"
        onClick={onDisconnect}
      >
        <LogOut className="size-3.5" />
        {shortenAddress(walletAddress, 4)}
      </Button>
    );
  }

  return (
    <Button
      variant="default"
      size="sm"
      className="!w-full justify-center gap-2"
      onClick={onConnect}
      disabled={loading}
    >
      <LogIn className="size-3.5" />
      {loading ? 'Connecting...' : 'Connect Stacks'}
    </Button>
  );
}

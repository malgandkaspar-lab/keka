"use client";

import { Alert, Badge, Button, Card, CardTitle, EmptyState } from "@/components/ui/primitives";
import { api } from "@/lib/client-api";
import { useAction } from "@/components/videos/video-actions";

interface AccountView {
  id: string;
  title: string;
  channelId: string;
  thumbnail: string | null;
  status: string;
  isDefault: boolean;
  lastError: string | null;
  analytics: boolean;
}

export function YouTubeAccounts({ accounts, configured }: { accounts: AccountView[]; configured: boolean }) {
  const { busy, error, run } = useAction();
  return (
    <Card>
      <CardTitle
        action={
          configured && (
            <a href="/api/youtube/connect">
              <Button size="sm">Connect channel</Button>
            </a>
          )
        }
      >
        Connected channels
      </CardTitle>
      {accounts.length === 0 ? (
        <EmptyState title="No channel connected">{configured ? "Click “Connect channel” to authorise with Google." : "Configure YouTube OAuth credentials first."}</EmptyState>
      ) : (
        <ul className="space-y-3">
          {accounts.map((account) => (
            <li key={account.id} className="flex items-center gap-3 rounded-lg border border-zinc-800 p-3">
              {account.thumbnail ? (
                // eslint-disable-next-line @next/next/no-img-element -- remote YouTube avatar
                <img src={account.thumbnail} alt="" className="h-10 w-10 rounded-full" />
              ) : (
                <div className="h-10 w-10 rounded-full bg-zinc-800" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-zinc-100">{account.title}</p>
                <p className="truncate text-xs text-zinc-500">{account.channelId}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <Badge tone={account.status === "ACTIVE" ? "success" : "danger"}>{account.status.toLowerCase()}</Badge>
                  {account.isDefault && <Badge tone="info">default</Badge>}
                  {!account.analytics && <Badge tone="warning">no analytics scope</Badge>}
                </div>
                {account.lastError && <p className="mt-1 text-xs text-red-300">{account.lastError}</p>}
              </div>
              <div className="flex flex-col gap-1">
                {!account.isDefault && (
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => run(`default-${account.id}`, () => api(`/api/youtube/accounts/${account.id}`, { method: "PATCH", json: { isDefault: true } }))}>
                    Make default
                  </Button>
                )}
                {account.status !== "ACTIVE" && configured && (
                  <a href="/api/youtube/connect">
                    <Button size="sm" variant="secondary">
                      Reconnect
                    </Button>
                  </a>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-red-300"
                  disabled={!!busy}
                  onClick={() => confirm(`Disconnect ${account.title}?`) && run(`del-${account.id}`, () => api(`/api/youtube/accounts/${account.id}`, { method: "DELETE" }))}
                >
                  Disconnect
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <div className="mt-3">
          <Alert tone="danger">{error}</Alert>
        </div>
      )}
    </Card>
  );
}

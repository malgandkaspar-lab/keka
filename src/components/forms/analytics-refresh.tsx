"use client";

import { useState } from "react";
import { Button } from "@/components/ui/primitives";
import { api, ApiClientError } from "@/lib/client-api";

export function AnalyticsRefresh() {
  const [state, setState] = useState<"idle" | "busy" | "queued" | string>("idle");
  return (
    <div className="flex items-center gap-3">
      {state === "queued" && <span className="text-sm text-zinc-400">Collection queued - refresh in a minute.</span>}
      {state !== "idle" && state !== "busy" && state !== "queued" && <span className="text-sm text-red-300">{state}</span>}
      <Button
        variant="secondary"
        disabled={state === "busy"}
        onClick={async () => {
          setState("busy");
          try {
            await api("/api/analytics/refresh", { method: "POST" });
            setState("queued");
          } catch (err) {
            setState(err instanceof ApiClientError ? err.message : "Failed");
          }
        }}
      >
        Refresh now
      </Button>
    </div>
  );
}

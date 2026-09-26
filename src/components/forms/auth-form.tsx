"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Alert, Button, Card, Input, Label } from "@/components/ui/primitives";
import { api, ApiClientError } from "@/lib/client-api";

export function AuthForm({ mode, firstRun }: { mode: "login" | "register"; firstRun?: boolean }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      await api(`/api/auth/${mode}`, {
        method: "POST",
        json: { email: form.get("email"), password: form.get("password"), name: form.get("name") || undefined },
      });
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong");
      setBusy(false);
    }
  }

  return (
    <Card>
      <form onSubmit={onSubmit} className="space-y-4">
        {firstRun && <Alert tone="info">Create the administrator account for this installation.</Alert>}
        {mode === "register" && (
          <div>
            <Label htmlFor="name">Name</Label>
            <Input id="name" name="name" autoComplete="name" />
          </div>
        )}
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <Label htmlFor="password" hint={mode === "register" ? "min. 10 characters" : undefined}>
            Password
          </Label>
          <Input id="password" name="password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 10 : 1} />
        </div>
        {error && <Alert tone="danger">{error}</Alert>}
        <Button type="submit" className="w-full" disabled={busy}>
          {busy ? "Please wait..." : mode === "login" ? "Sign in" : "Create account"}
        </Button>
        <p className="text-center text-sm text-zinc-500">
          {mode === "login" ? (
            <>
              No account? <Link className="text-accent-300 hover:underline" href="/register">Create one</Link>
            </>
          ) : (
            <>
              Already registered? <Link className="text-accent-300 hover:underline" href="/login">Sign in</Link>
            </>
          )}
        </p>
      </form>
    </Card>
  );
}

import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { createLogger } from "@/lib/logger";
import { logEvent } from "@/services/logging/system-log";
import { connectAccount, verifyOAuthState } from "@/services/youtube/youtube-service";

const log = createLogger({ module: "youtube-oauth" });

/** OAuth redirect target: verifies state, exchanges the code and stores encrypted tokens. */
export async function GET(req: NextRequest) {
  const base = process.env.APP_URL ?? req.nextUrl.origin;
  const redirect = (query: string) => NextResponse.redirect(new URL(`/youtube?${query}`, base));
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL("/login", base));
  const params = req.nextUrl.searchParams;
  if (params.get("error")) return redirect(`error=${encodeURIComponent(params.get("error")!)}`);
  const code = params.get("code");
  const state = params.get("state");
  const store = await cookies();
  const nonce = store.get("sf_oauth_nonce")?.value;
  store.delete("sf_oauth_nonce");
  if (!code || !state) return redirect("error=missing_code");
  try {
    verifyOAuthState(state, user.id, nonce);
    const account = await connectAccount(user.id, code);
    await logEvent({ userId: user.id, message: `YouTube channel connected: ${account.channelTitle}`, provider: "youtube" });
    return redirect("connected=1");
  } catch (error) {
    log.warn({ err: (error as Error).message }, "YouTube connection failed");
    return redirect(`error=${encodeURIComponent((error as Error).message.slice(0, 200))}`);
  }
}

import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/api";
import { requireUser } from "@/lib/auth";
import { createOAuthState, getYouTubeProvider } from "@/services/youtube/youtube-service";

/** Starts the Google OAuth 2.0 consent flow (the password is entered on Google only). */
export async function GET() {
  try {
    const user = await requireUser();
    const provider = getYouTubeProvider();
    const { state, nonce } = createOAuthState(user.id);
    (await cookies()).set("sf_oauth_nonce", nonce, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production" && (process.env.APP_URL ?? "").startsWith("https://"),
      path: "/api/youtube",
      maxAge: 600,
    });
    return NextResponse.redirect(provider.authorizationUrl(state));
  } catch (error) {
    return errorResponse(error);
  }
}

import { YouTubeAccounts } from "@/components/forms/youtube-accounts";
import { Alert, Card, CardTitle, PageHeader } from "@/components/ui/primitives";
import { credentialStatus, getEnv } from "@/config/env";
import { requirePageUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "YouTube" };

export default async function YouTubePage(props: PageProps<"/youtube">) {
  const user = await requirePageUser();
  const params = await props.searchParams;
  const accounts = await db.youTubeAccount.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
  const configured = credentialStatus().youtube;
  const redirectUri = getEnv().YOUTUBE_REDIRECT_URI ?? `${getEnv().APP_URL}/api/youtube/callback`;

  return (
    <>
      <PageHeader title="YouTube" description="Connect channels with Google OAuth 2.0. Your Google password is never shared with this app." />
      <div className="space-y-4">
        {params.connected && <Alert tone="success">YouTube channel connected.</Alert>}
        {typeof params.error === "string" && <Alert tone="danger">Connection failed: {params.error}</Alert>}
        {!configured && (
          <Alert tone="warning">
            YouTube is not configured. Set <code>YOUTUBE_CLIENT_ID</code>, <code>YOUTUBE_CLIENT_SECRET</code> and <code>YOUTUBE_REDIRECT_URI</code> (register{" "}
            <code>{redirectUri}</code> as an authorised redirect URI in Google Cloud Console). See the README.
          </Alert>
        )}
        <div className="grid gap-6 lg:grid-cols-2">
          <YouTubeAccounts
            configured={Boolean(configured)}
            accounts={accounts.map((a) => ({
              id: a.id,
              title: a.channelTitle,
              channelId: a.googleChannelId,
              thumbnail: a.channelThumbnail,
              status: a.status,
              isDefault: a.isDefault,
              lastError: a.lastError,
              analytics: a.scopes.some((s) => s.includes("yt-analytics")),
            }))}
          />
          <Card>
            <CardTitle>How publishing works</CardTitle>
            <ul className="list-disc space-y-2 pl-5 text-sm text-zinc-300">
              <li>Videos are uploaded with the YouTube Data API v3 (resumable, retried on failure).</li>
              <li>Privacy: private, unlisted, public, or scheduled (uploaded private with a publish time).</li>
              <li>Duplicate protection: a video that already has a YouTube ID is never uploaded again, and retries adopt an upload that already reached YouTube.</li>
              <li>A final English check runs before every upload - non-English metadata is never sent.</li>
              <li>AI narration is disclosed with YouTube&apos;s altered/synthetic content flag.</li>
              <li>OAuth tokens are encrypted at rest (AES-256-GCM).</li>
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

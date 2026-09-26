import { cookies } from "next/headers";
import { json, route } from "@/lib/api";
import { revokeSession, SESSION_COOKIE } from "@/services/auth/auth-service";

export const POST = route(async () => {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await revokeSession(token);
  store.delete(SESSION_COOKIE);
  return json({ ok: true });
});

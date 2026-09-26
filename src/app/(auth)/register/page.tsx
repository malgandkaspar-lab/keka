import { redirect } from "next/navigation";
import { AuthForm } from "@/components/forms/auth-form";
import { getEnv } from "@/config/env";
import { Alert } from "@/components/ui/primitives";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "Create account" };

export default async function RegisterPage() {
  if (await getCurrentUser()) redirect("/");
  const firstRun = (await db.user.count()) === 0;
  if (!firstRun && !getEnv().ALLOW_REGISTRATION) {
    return <Alert tone="warning">Registration is disabled on this installation. Ask the administrator for an account.</Alert>;
  }
  return <AuthForm mode="register" firstRun={firstRun} />;
}

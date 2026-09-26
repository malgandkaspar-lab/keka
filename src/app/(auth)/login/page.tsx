import { redirect } from "next/navigation";
import { AuthForm } from "@/components/forms/auth-form";
import { getCurrentUser } from "@/lib/auth";
import { db } from "@/lib/db";

export const metadata = { title: "Sign in" };

export default async function LoginPage() {
  if (await getCurrentUser()) redirect("/");
  if ((await db.user.count()) === 0) redirect("/register");
  return <AuthForm mode="login" />;
}

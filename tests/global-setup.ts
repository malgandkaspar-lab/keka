import { execSync } from "node:child_process";

/** Applies migrations and seed data to the isolated test database once per run. */
export default function setup(): void {
  const url = process.env.TEST_DATABASE_URL ?? "postgresql://shorts:shorts@localhost:5432/shorts_factory_test";
  const env = { ...process.env, DATABASE_URL: url };
  execSync("npx prisma migrate deploy", { env, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", { env, stdio: "pipe" });
}

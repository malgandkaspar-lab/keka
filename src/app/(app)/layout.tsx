import { Sidebar } from "@/components/layout/sidebar";
import { requirePageUser } from "@/lib/auth";

export default async function AppLayout({ children }: LayoutProps<"/">) {
  const user = await requirePageUser();
  return (
    <div className="min-h-screen">
      <Sidebar email={user.email} />
      <main className="lg:pl-60">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8 lg:py-8">{children}</div>
      </main>
    </div>
  );
}

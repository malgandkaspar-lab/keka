export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-accent-500 font-bold text-white">SF</div>
          <h1 className="text-xl font-semibold text-white">
            Shorts<span className="text-accent-400">Factory</span>
          </h1>
          <p className="mt-1 text-sm text-zinc-400">English YouTube Shorts, fully automated.</p>
        </div>
        {children}
      </div>
    </div>
  );
}

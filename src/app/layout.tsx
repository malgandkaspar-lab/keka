import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Shorts Factory", template: "%s · Shorts Factory" },
  description: "Automatically create, render and publish English YouTube Shorts.",
};

export const viewport: Viewport = { themeColor: "#09090b" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full bg-zinc-950 font-sans text-zinc-200">{children}</body>
    </html>
  );
}

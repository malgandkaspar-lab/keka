import { cn } from "@/components/ui/primitives";

/** 9:16 thumbnail tile, served through the authenticated media route. */
export function mediaUrl(storageKey: string | null | undefined): string | null {
  if (!storageKey) return null;
  return `/api/media/${storageKey.split("/").map(encodeURIComponent).join("/")}`;
}

export function VideoThumb({ storageKey, className, alt }: { storageKey: string | null | undefined; className?: string; alt: string }) {
  const url = mediaUrl(storageKey);
  return (
    <div className={cn("relative aspect-[9/16] overflow-hidden rounded-lg bg-zinc-800", className)}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element -- authenticated media route, not optimisable
        <img src={url} alt={alt} className="h-full w-full object-cover" loading="lazy" />
      ) : (
        <div className="flex h-full items-center justify-center text-xs text-zinc-500">No preview</div>
      )}
    </div>
  );
}

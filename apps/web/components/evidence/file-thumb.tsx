"use client";

import { useState } from "react";

/**
 * Thumbnail from a short-lived signed link rendered with the page. If that link has expired by the time the image
 * loads (lazy loading, a page left open), it retries once through the same-origin `/files/...` redirect, which asks
 * for a fresh link; after that it shows the placeholder.
 */
export function FileThumb({
  src,
  fallbackHref,
  alt,
  placeholder,
  className = "size-full object-cover",
}: {
  src: string | null;
  fallbackHref: string;
  alt: string;
  placeholder: React.ReactNode;
  className?: string;
}) {
  const [current, setCurrent] = useState<string | null>(src);
  const [retried, setRetried] = useState(false);
  if (!current) return <>{placeholder}</>;
  return (
    // Short-lived signed storage URL; next/image would need every storage host in remotePatterns.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={current}
      alt={alt}
      className={className}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        if (retried) setCurrent(null);
        else {
          setRetried(true);
          setCurrent(fallbackHref);
        }
      }}
    />
  );
}

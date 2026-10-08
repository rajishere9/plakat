/**
 * Live page preview rendered through the export path (renderer exportPage → PNG).
 * Re-renders (debounced) when the page, the page size or the asset registry changes;
 * shows the page background color while rendering or when rendering fails.
 */
import { useEffect, useState, type JSX } from 'react';
import type { Page, PlakatDocument } from '@plakat/schema';
import { useServices } from '../app/services.tsx';
import { cx } from './ui.tsx';

export interface PageThumbnailProps {
  doc: PlakatDocument;
  page: Page;
  maxSide?: number;
  className?: string;
  alt?: string;
  /** Debounce before re-rendering after a change (ms, default 400). */
  delay?: number;
}

export function PageThumbnail({ doc, page, maxSide = 240, className, alt = '', delay = 400 }: PageThumbnailProps): JSX.Element {
  const { renderPreview } = useServices();
  const [url, setUrl] = useState<string | null>(null);
  const { size, assets } = doc;

  useEffect(() => {
    let cancelled = false;
    let created: string | null = null;
    const timer = setTimeout(
      () => {
        const mini: PlakatDocument = { ...doc, pages: [page] };
        renderPreview(mini, page.id, maxSide)
          .then((blob) => {
            if (cancelled || typeof URL.createObjectURL !== 'function') return;
            created = URL.createObjectURL(blob);
            setUrl(created);
          })
          .catch(() => {
            /* keep the previous image / background placeholder */
          });
      },
      url ? delay : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (created) {
        const u = created;
        // Keep the old image until the next one replaces it.
        setTimeout(() => URL.revokeObjectURL(u), 5000);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, size, assets, maxSide, renderPreview]);

  const bg = page.background.color;
  return (
    <div
      className={cx('page-thumb', !bg && 'page-thumb--transparent', className)}
      style={{ aspectRatio: `${size.width} / ${size.height}`, background: bg ?? undefined }}
    >
      {url && <img src={url} alt={alt} draggable={false} />}
    </div>
  );
}

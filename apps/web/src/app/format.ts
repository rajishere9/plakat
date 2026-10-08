/** Display formatting helpers (sizes, dates, categories). */
import { exportPixelSize, type PageSize, type PhysicalSize } from '@plakat/schema';

const trim = (n: number, decimals = 2) => String(Math.round(n * 10 ** decimals) / 10 ** decimals);

export function formatPhysical(p: PhysicalSize): string {
  return `${trim(p.width)} × ${trim(p.height)} ${p.unit}`;
}

/** Pixel size of a page at 1x (rounded the same way exports are). */
export function formatPx(size: Pick<PageSize, 'width' | 'height'>): string {
  const d = exportPixelSize(size, 1);
  return `${d.width} × ${d.height} px`;
}

/** "210 × 297 mm" for print sizes, else "1080 × 1080 px". */
export function formatPageSize(size: Pick<PageSize, 'width' | 'height'> & { physical?: PhysicalSize | null }): string {
  return size.physical ? formatPhysical(size.physical) : formatPx(size);
}

export function formatDims(d: { width: number; height: number }): string {
  return `${d.width} × ${d.height} px`;
}

const CATEGORY_WORDS: Record<string, string> = { youtube: 'YouTube', instagram: 'Instagram', us: 'US', eu: 'EU', a4: 'A4' };

/** 'youtube-thumbnail' -> 'YouTube thumbnail'; nested 'a/b' -> 'A / B'. */
export function categoryLabel(category: string | null | undefined): string {
  if (!category) return 'Uncategorized';
  return category
    .split('/')
    .map((part) =>
      part
        .split(/[-_\s]+/)
        .filter(Boolean)
        .map((w, i) => CATEGORY_WORDS[w.toLowerCase()] ?? (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
        .join(' '),
    )
    .join(' / ');
}

/** "just now", "5 min ago", "3 h ago", "yesterday", else a short date. */
export function formatRelativeTime(iso: string, now: Date = new Date()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((now.getTime() - t) / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${trim(n / 1024, 0)} KB`;
  return `${trim(n / 1024 / 1024, 1)} MB`;
}

/**
 * File-name slug: lowercase ASCII letters/digits separated by single dashes (diacritics
 * folded, everything else dropped), at most 80 characters. May return '' (callers fall
 * back to 'plakat').
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[øØ]/g, 'o')
    .replace(/[łŁ]/g, 'l')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
}

/** `slugify(title) || 'plakat'`. */
export function exportBaseName(title: string): string {
  return slugify(title) || 'plakat';
}

/** 1-based page number zero-padded to the page-count width (at least 2 digits): 1 of 3 → "01". */
export function pageNumberLabel(pageNumber: number, pageCount: number): string {
  const width = Math.max(2, String(Math.max(1, pageCount)).length);
  return String(pageNumber).padStart(width, '0');
}

/** `<base>-<NN>.<ext>` for a page inside a multi-page export (P-11). */
export function pageFileName(base: string, pageNumber: number, pageCount: number, ext: string): string {
  return `${base}-${pageNumberLabel(pageNumber, pageCount)}.${ext}`;
}

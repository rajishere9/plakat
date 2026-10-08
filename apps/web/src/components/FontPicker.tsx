/**
 * Font family picker: searchable listbox over GOOGLE_FONTS_CATALOG with brand fonts and
 * document fonts first. Each option is previewed in its own face (stylesheets are
 * injected lazily as options scroll into view).
 */
import { useEffect, useId, useMemo, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { FONT_FAMILY_PATTERN, getFontInfo, type FontCategory } from '@plakat/schema';
import { ensureFontPreview, FONT_CATEGORY_LABELS, getFontPickerGroups, searchFonts } from '../lib/fonts.ts';
import { Icon } from './Icon.tsx';
import { Popover } from './Popover.tsx';
import { cx } from './ui.tsx';

export interface FontOption {
  family: string;
  /** e.g. 'Heading' for brand fonts, the category label for catalog fonts. */
  note?: string;
}

export interface FontOptionGroup {
  id: string;
  label: string;
  options: FontOption[];
}

export interface BrandFontHint {
  family: string;
  /** Role label shown next to the family ("Heading"). */
  role: string;
}

/**
 * The picker's groups for a query: brand fonts, document fonts, then the catalog
 * (grouped by category when the query is empty, a flat "Results" group otherwise).
 * A non-catalogued but valid family name typed in full is offered as "Use …".
 */
export function filterFontOptions(query: string, brandFonts: readonly BrandFontHint[] = [], documentFonts: readonly string[] = []): FontOptionGroup[] {
  const q = query.trim().toLowerCase();
  const match = (family: string) => !q || family.toLowerCase().includes(q);
  const groups: FontOptionGroup[] = [];
  const seenBrand = new Set<string>();
  const brand = brandFonts
    .filter((b) => match(b.family))
    .filter((b) => (seenBrand.has(b.family) ? false : (seenBrand.add(b.family), true)))
    .map((b) => ({ family: b.family, note: brandFonts.filter((x) => x.family === b.family).map((x) => x.role).join(', ') }));
  if (brand.length) groups.push({ id: 'brand', label: 'Brand fonts', options: brand });
  const docFonts = [...new Set(documentFonts)].filter((f) => match(f) && !seenBrand.has(f)).map((family) => ({ family }));
  if (docFonts.length) groups.push({ id: 'document', label: 'Used in this design', options: docFonts });
  if (!q) {
    for (const g of getFontPickerGroups()) {
      groups.push({ id: `cat-${g.category}`, label: g.label, options: g.fonts.map((f) => ({ family: f.family })) });
    }
  } else {
    const shown = new Set([...brand, ...docFonts].map((o) => o.family));
    const results = searchFonts(q)
      .filter((f) => !shown.has(f.family))
      .map((f) => ({ family: f.family, note: FONT_CATEGORY_LABELS[f.category as FontCategory] }));
    if (results.length) groups.push({ id: 'results', label: 'Results', options: results });
    const typed = query.trim().replace(/\s+/g, ' ');
    const exists = groups.some((g) => g.options.some((o) => o.family.toLowerCase() === typed.toLowerCase()));
    if (!exists && FONT_FAMILY_PATTERN.test(typed) && !getFontInfo(typed)) {
      groups.push({ id: 'custom', label: 'Other Google font', options: [{ family: typed, note: 'Not in catalog' }] });
    }
  }
  return groups;
}

export interface FontPickerProps {
  label: string;
  /** Current family; null = mixed selection. */
  value: string | null;
  onChange: (family: string) => void;
  brandFonts?: readonly BrandFontHint[];
  documentFonts?: readonly string[];
  disabled?: boolean;
  className?: string;
  /** Shown when value is null (default "Mixed"). */
  placeholder?: string;
}

function useLazyPreview(root: HTMLElement | null, deps: unknown) {
  useEffect(() => {
    if (!root) return;
    const nodes = [...root.querySelectorAll<HTMLElement>('[data-font]')];
    if (typeof IntersectionObserver === 'undefined') {
      nodes.slice(0, 40).forEach((n) => ensureFontPreview(n.dataset['font']!));
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            ensureFontPreview((e.target as HTMLElement).dataset['font']!);
            io.unobserve(e.target);
          }
        }
      },
      { root, rootMargin: '120px' },
    );
    nodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [root, deps]);
}

export function FontPicker({ label, value, onChange, brandFonts = [], documentFonts = [], disabled, className, placeholder = 'Mixed' }: FontPickerProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement>(null);
  const [listEl, setListEl] = useState<HTMLDivElement | null>(null);
  const listId = useId();

  const groups = useMemo(() => filterFontOptions(query, brandFonts, documentFonts), [query, brandFonts, documentFonts]);
  const flat = useMemo(() => groups.flatMap((g) => g.options.map((o) => ({ ...o, group: g.id }))), [groups]);
  useLazyPreview(listEl, groups);

  useEffect(() => {
    if (value) ensureFontPreview(value);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
  }, [open]);

  useEffect(() => {
    // Highlight the current family when opening / when results change.
    const idx = flat.findIndex((o) => o.family === value);
    setActive(idx >= 0 && !query ? idx : 0);
  }, [flat, value, query]);

  useEffect(() => {
    listEl?.querySelector(`[data-index="${active}"]`)?.scrollIntoView?.({ block: 'nearest' });
  }, [active, listEl]);

  const choose = (family: string) => {
    onChange(family);
    setOpen(false);
    anchor.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(flat.length - 1, a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = flat[active];
      if (opt) choose(opt.family);
    }
  };

  let index = -1;
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={cx('font-trigger', className)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${value ?? placeholder}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="font-trigger__name" style={value ? { fontFamily: `"${value}", var(--font-ui)` } : undefined}>
          {value ?? placeholder}
        </span>
        <Icon name="chevronDown" size={14} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label={label} className="font-pop" width={288}>
        <div className="font-pop__search">
          <Icon name="search" size={16} />
          <input
            data-autofocus=""
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={flat[active] ? `${listId}-${active}` : undefined}
            aria-label="Search fonts"
            placeholder="Search fonts"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div ref={setListEl} id={listId} role="listbox" aria-label="Fonts" className="font-pop__list">
          {flat.length === 0 && <div className="font-pop__empty">No fonts match “{query}”.</div>}
          {groups.map((g) => (
            <div key={g.id} role="group" aria-label={g.label} className="font-pop__group">
              <div className="font-pop__group-label" aria-hidden="true">
                {g.label}
              </div>
              {g.options.map((o) => {
                index++;
                const i = index;
                const selected = o.family === value;
                return (
                  <div
                    key={`${g.id}-${o.family}`}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={selected}
                    data-index={i}
                    data-font={o.family}
                    className={cx('font-opt', i === active && 'is-active', selected && 'is-selected')}
                    onMouseEnter={() => setActive(i)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(o.family)}
                  >
                    <span className="font-opt__name" style={{ fontFamily: `"${o.family}", var(--font-ui)` }}>
                      {o.family}
                    </span>
                    {o.note && <span className="font-opt__note">{o.note}</span>}
                    {selected && <Icon name="check" size={14} />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

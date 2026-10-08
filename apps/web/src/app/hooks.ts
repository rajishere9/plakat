/** Shared React hooks: debounced values, async loading, template lists, color palettes. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { documentColorsByUsage, type Color } from '@plakat/schema';
import type { TemplateSummary } from '../api/index.ts';
import type { ColorPalette } from '../components/ColorPicker.tsx';
import { selectActiveBrandKit } from '../store/index.ts';
import { useEd, useServices } from './services.tsx';

export function useDebouncedValue<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
}

/** Runs `fn` when deps change; ignores stale results. */
export function useAsync<T>(fn: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<{ data: T | undefined; error: unknown; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fnRef.current().then(
      (data) => !cancelled && setState({ data, error: null, loading: false }),
      (error: unknown) => !cancelled && setState((s) => ({ data: s.data, error, loading: false })),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { ...state, reload };
}

/** Template list with category + debounced search filters (server-side filtering). */
export function useTemplates(category: string | null, query: string): AsyncState<TemplateSummary[]> {
  const { api } = useServices();
  const q = useDebouncedValue(query.trim(), 250);
  return useAsync(() => api.listTemplates({ category, q }), [api, category, q]);
}

/** Distinct categories in list order. */
export function templateCategories(items: readonly TemplateSummary[]): string[] {
  return [...new Set(items.map((t) => t.category).filter((c): c is string => !!c))].sort((a, b) => a.localeCompare(b));
}

/** Brand colors (active kit) + document colors, for color pickers. */
export function useColorPalettes(): ColorPalette[] {
  const kit = useEd(selectActiveBrandKit);
  const pages = useEd((s) => s.document.pages);
  const docColors = useMemo<Color[]>(() => documentColorsByUsage({ pages }).slice(0, 16), [pages]);
  return useMemo(() => {
    const out: ColorPalette[] = [];
    if (kit && kit.colors.length) out.push({ id: 'brand', title: kit.name ? `Brand · ${kit.name}` : 'Brand colors', colors: kit.colors.map((c) => c.value) });
    if (docColors.length) out.push({ id: 'document', title: 'Document colors', colors: docColors });
    return out;
  }, [kit, docColors]);
}

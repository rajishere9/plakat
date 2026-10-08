/**
 * Photos flyout: pluggable asset providers (Openverse by default). Debounced search,
 * infinite scroll, attribution on every result; clicking a result asks the server to
 * import the full image into /uploads (same-origin, so the canvas is never tainted) and
 * inserts it with its attribution kept in the asset's `source`.
 */
import { useEffect, useRef, useState, type JSX } from 'react';
import { ApiError, providerImportToAssetInput, type AssetProviderInfo, type AssetSearchItem } from '../api/index.ts';
import { useAsync, useDebouncedValue } from '../app/hooks.ts';
import { useServices, useStoreApi } from '../app/services.tsx';
import { errorMessage, toast } from '../app/toasts.tsx';
import { Button, EmptyState, Notice, Select, Spinner, cx } from '../components/ui.tsx';
import { PanelShell } from './PanelShell.tsx';
import { SearchInput } from './TemplatesPanel.tsx';

const SUGGESTIONS = ['Nature', 'City', 'Abstract', 'Food', 'Coffee', 'Mountains', 'Ocean', 'Flowers'];
const PER_PAGE = 20;

export function attributionText(item: Pick<AssetSearchItem, 'title' | 'creator' | 'license'>): string {
  const parts = [item.title ? `“${item.title}”` : 'Untitled', item.creator ? `by ${item.creator}` : null, item.license].filter(Boolean);
  return parts.join(' · ');
}

/** User-facing text for a failed search; the raw server message is kept as secondary detail. */
export function searchErrorMessage(e: unknown): { message: string; detail: string | null } {
  if (e instanceof ApiError && e.code === 'rate_limited') return { message: 'The photo service is rate limiting requests. Try again in a minute.', detail: null };
  if (e instanceof ApiError && (e.code === 'network_error' || e.status === 0)) return { message: 'Could not reach the server. Check your connection and try again.', detail: null };
  return { message: 'Photo search is unavailable right now.', detail: errorMessage(e) };
}

export function PhotosPanel({ onClose }: { onClose?: () => void }): JSX.Element {
  const services = useServices();
  const store = useStoreApi();
  const providers = useAsync(() => services.api.listAssetProviders(), [services.api]);
  const [providerId, setProviderId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const q = useDebouncedValue(query.trim(), 400);
  const [results, setResults] = useState<AssetSearchItem[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<{ message: string; detail: string | null; page: number } | null>(null);
  const [importing, setImporting] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const reqSeq = useRef(0);

  const list = providers.data ?? [];
  const provider: AssetProviderInfo | undefined = list.find((p) => p.id === providerId) ?? list[0];
  const needsKey = !!provider && provider.requiresKey && !provider.configured;

  const load = async (pageNo: number, reset: boolean) => {
    if (!provider || !q || needsKey) return;
    const seq = ++reqSeq.current;
    setLoading(true);
    setError(null);
    try {
      const r = await services.api.searchAssets(provider.id, { q, page: pageNo, perPage: PER_PAGE });
      if (seq !== reqSeq.current) return;
      setResults((prev) => {
        const base = reset ? [] : prev;
        const seen = new Set(base.map((x) => x.id));
        return [...base, ...r.items.filter((x) => !seen.has(x.id))];
      });
      setPage(r.page);
      setHasMore(r.hasMore);
    } catch (e) {
      if (seq !== reqSeq.current) return;
      setError({ ...searchErrorMessage(e), page: pageNo });
      setHasMore(false);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  };

  useEffect(() => {
    setResults([]);
    setPage(1);
    setHasMore(false);
    if (q) void load(1, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, provider?.id, needsKey]);

  // Infinite scroll: load the next page when the sentinel becomes visible.
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasMore || loading || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) void load(page + 1, false);
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loading, page, results.length]);

  const insert = async (item: AssetSearchItem) => {
    if (!provider) return;
    setImporting(item.id);
    try {
      const res = await services.api.importAsset(provider.id, item.id);
      store.getState().actions.addImage(providerImportToAssetInput(res, item.id));
    } catch (e) {
      toast.error('Could not import the photo', { detail: errorMessage(e) });
    } finally {
      setImporting(null);
    }
  };

  return (
    <PanelShell
      title="Photos"
      onClose={onClose}
      header={
        <>
          {list.length > 1 && (
            <Select
              aria-label="Photo provider"
              value={provider?.id ?? ''}
              onChange={(e) => setProviderId(e.target.value)}
              options={list.map((p) => ({ value: p.id, label: p.name + (p.requiresKey && !p.configured ? ' (not configured)' : '') }))}
            />
          )}
          <SearchInput value={query} onChange={setQuery} label={`Search ${provider?.name ?? 'photos'}`} />
        </>
      }
    >
      {providers.loading && !providers.data ? (
        <div className="panel__center">
          <Spinner label="Loading photo providers" />
        </div>
      ) : providers.error ? (
        <EmptyState tone="error" title="Photo search is unavailable" compact action={<Button onClick={providers.reload}>Retry</Button>}>
          {errorMessage(providers.error)}
        </EmptyState>
      ) : !provider ? (
        <EmptyState icon="photos" title="No photo providers" compact>
          The server has no asset providers enabled.
        </EmptyState>
      ) : needsKey ? (
        <Notice tone="warning">
          <strong>{provider.name} needs an API key.</strong> Ask your administrator to configure it on the server (see <code>.env.example</code>).{' '}
          {provider.homepage && (
            <a href={provider.homepage} target="_blank" rel="noreferrer">
              Learn more
            </a>
          )}
        </Notice>
      ) : (
        <>
          {!q && (
            <>
              <p className="panel__hint">{provider.description || `Search free photos from ${provider.name}.`}</p>
              <div className="chips" role="group" aria-label="Suggested searches">
                {SUGGESTIONS.map((s) => (
                  <button key={s} type="button" className="chip" onClick={() => setQuery(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}
          {error && (
            <Notice tone="error">
              <p>{error.message}</p>
              {error.detail && <p className="panel__fineprint">{error.detail}</p>}
              <Button size="sm" onClick={() => void load(error.page, error.page === 1)} disabled={loading}>
                Retry
              </Button>
            </Notice>
          )}
          {q && !loading && !error && results.length === 0 && (
            <EmptyState icon="photos" title="No photos found" compact>
              Try a different search.
            </EmptyState>
          )}
          {results.length > 0 && (
            <div className="photo-grid" aria-busy={loading}>
              {results.map((item) => (
                <figure key={item.id} className={cx('photo', importing === item.id && 'is-busy')}>
                  <button
                    type="button"
                    className="photo__btn"
                    onClick={() => void insert(item)}
                    disabled={importing !== null}
                    aria-label={`Insert photo: ${attributionText(item)}`}
                    title={attributionText(item)}
                  >
                    <img src={item.thumbUrl} alt="" loading="lazy" referrerPolicy="no-referrer" style={{ aspectRatio: `${item.width || 4} / ${item.height || 3}` }} />
                    {importing === item.id && (
                      <span className="photo__busy">
                        <Spinner size={18} />
                      </span>
                    )}
                  </button>
                  <figcaption className="photo__credit">
                    {item.creator ? (
                      item.creatorUrl ? (
                        <a href={item.creatorUrl} target="_blank" rel="noreferrer">
                          {item.creator}
                        </a>
                      ) : (
                        item.creator
                      )
                    ) : (
                      'Unknown author'
                    )}
                    {item.license && (
                      <>
                        {' · '}
                        {item.licenseUrl ? (
                          <a href={item.licenseUrl} target="_blank" rel="noreferrer">
                            {item.license}
                          </a>
                        ) : (
                          item.license
                        )}
                      </>
                    )}
                  </figcaption>
                </figure>
              ))}
            </div>
          )}
          {loading && (
            <div className="panel__center">
              <Spinner label="Searching" />
            </div>
          )}
          {hasMore && !loading && (
            <div ref={sentinel} className="panel__center">
              <Button size="sm" onClick={() => void load(page + 1, false)}>
                Load more
              </Button>
            </div>
          )}
          {provider.licenseNote && <p className="panel__fineprint">{provider.licenseNote}</p>}
        </>
      )}
    </PanelShell>
  );
}

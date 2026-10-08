/** Template gallery card with a lazily loaded preview (server thumbnail or rendered fallback). */
import { useEffect, useRef, useState, type JSX, type RefObject } from 'react';
import type { TemplateSummary } from '../api/index.ts';
import { categoryLabel, formatPx } from '../app/format.ts';
import { useServices } from '../app/services.tsx';
import { templatePreviewUrl } from '../app/template-previews.ts';
import { Menu, type MenuEntry } from './Menu.tsx';
import { Icon } from './Icon.tsx';
import { Spinner, cx } from './ui.tsx';

/** Starts work once the element is (nearly) visible; immediately where IntersectionObserver is unavailable. */
export function useInView<T extends Element>(rootMargin = '200px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [inView, setInView] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (inView || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      { rootMargin },
    );
    io.observe(ref.current);
    return () => io.disconnect();
  }, [inView, rootMargin]);
  return [ref, inView];
}

export function TemplatePreview({ summary, className }: { summary: TemplateSummary; className?: string }): JSX.Element {
  const services = useServices();
  const [ref, inView] = useInView<HTMLDivElement>();
  const [url, setUrl] = useState<string | null>(summary.thumbnailUrl);
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>(summary.thumbnailUrl ? 'idle' : 'loading');

  useEffect(() => {
    if (!inView) return;
    let cancelled = false;
    if (summary.thumbnailUrl) {
      setUrl(summary.thumbnailUrl);
      setState('idle');
      return;
    }
    setState('loading');
    templatePreviewUrl(summary, services).then((u) => {
      if (cancelled) return;
      setUrl(u);
      setState(u ? 'idle' : 'failed');
    });
    return () => {
      cancelled = true;
    };
  }, [inView, summary, services]);

  return (
    <div
      ref={ref}
      className={cx('tpl-preview', className)}
      style={{
        aspectRatio: `${summary.size.width} / ${summary.size.height}`,
        ...(summary.size.width >= summary.size.height ? { width: 'calc(100% - 2 * var(--tpl-pad))' } : { height: 'calc(100% - 2 * var(--tpl-pad))' }),
      }}
    >
      {url ? (
        <img src={url} alt="" loading="lazy" draggable={false} onError={() => setState('failed')} />
      ) : state === 'loading' ? (
        <Spinner size={18} />
      ) : (
        <Icon name="templates" size={24} />
      )}
    </div>
  );
}

export interface TemplateCardProps {
  summary: TemplateSummary;
  onOpen: () => void;
  /** Accessible verb for the main action, e.g. "Use template". */
  actionLabel?: string;
  menu?: ReadonlyArray<MenuEntry>;
  busy?: boolean;
  compact?: boolean;
}

export function TemplateCard({ summary, onOpen, actionLabel = 'Use template', menu, busy, compact }: TemplateCardProps): JSX.Element {
  return (
    <div className={cx('tpl-card', compact && 'tpl-card--compact', busy && 'is-busy')}>
      <button type="button" className="tpl-card__main" onClick={onOpen} aria-label={`${actionLabel}: ${summary.title}`} disabled={busy}>
        <TemplatePreview summary={summary} />
        {busy && (
          <span className="tpl-card__busy">
            <Spinner size={20} />
          </span>
        )}
      </button>
      <div className="tpl-card__meta">
        <div className="tpl-card__text">
          <div className="tpl-card__title" title={summary.title}>
            {summary.title || 'Untitled template'}
          </div>
          {!compact && (
            <div className="tpl-card__sub">
              {categoryLabel(summary.category)} · {formatPx(summary.size)}
              {summary.pageCount > 1 ? ` · ${summary.pageCount} pages` : ''}
            </div>
          )}
        </div>
        {menu && menu.length > 0 && (
          <Menu
            label={`${summary.title} actions`}
            items={menu}
            placement="bottom-end"
            trigger={(props) => (
              <button {...props} type="button" className="icon-btn icon-btn--sm icon-btn--ghost" aria-label={`More actions for ${summary.title}`} title="More actions">
                <Icon name="more" size={16} />
              </button>
            )}
          />
        )}
      </div>
    </div>
  );
}

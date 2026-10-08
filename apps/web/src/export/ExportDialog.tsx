/**
 * Export dialog: format (PNG / JPG / PDF as 300 dpi image), scale with the exact output
 * pixel size (exportPixelSize), JPG quality, page selection (current / all / range),
 * canvas-limit warning, progress, then exportDocument() + download (one file, or a ZIP
 * for several PNG/JPG pages).
 */
import { useEffect, useId, useState, type JSX } from 'react';
import { AssetLoadError, CanvasLimitError, DEFAULT_JPEG_QUALITY, exportDocument, FontLoadError } from '@plakat/renderer';
import type { ExportScaleId } from '@plakat/schema';
import { useEd, useServices } from '../app/services.tsx';
import { errorMessage, toast } from '../app/toasts.tsx';
import { Dialog } from '../components/Dialog.tsx';
import { Icon } from '../components/Icon.tsx';
import { Slider } from '../components/Slider.tsx';
import { Button, Notice, ProgressBar, cx } from '../components/ui.tsx';
import { downloadBlob } from './download.ts';
import {
  browserCanvasLimits,
  defaultScaleFor,
  exportSummary,
  FORMAT_OPTIONS,
  resolvePageIds,
  SCALE_OPTIONS,
  type ExportFormatId,
  type PageSelection,
} from './export-options.ts';

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Injection points for tests. */
  exporter?: typeof exportDocument;
  download?: typeof downloadBlob;
}

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'error'; message: string; fontFailure?: boolean };

export function ExportDialog({ open, onClose, exporter = exportDocument, download = downloadBlob }: ExportDialogProps): JSX.Element | null {
  const services = useServices();
  const doc = useEd((s) => s.document);
  const activePageId = useEd((s) => s.activePageId);
  const [format, setFormat] = useState<ExportFormatId>('png');
  const [scale, setScale] = useState<ExportScaleId>('1x');
  const [quality, setQuality] = useState(DEFAULT_JPEG_QUALITY);
  const [pages, setPages] = useState<PageSelection>('all');
  const [range, setRange] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const rangeId = useId();
  const pageCount = doc.pages.length;

  useEffect(() => {
    if (open) {
      setStatus({ kind: 'idle' });
      setPages(pageCount > 1 ? 'all' : 'current');
      setRange(pageCount > 1 ? `1-${pageCount}` : '1');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const limits = browserCanvasLimits();
  const summary = exportSummary(doc.size, format, scale, limits);
  const pageIds = resolvePageIds(doc, pages, activePageId, range);
  const rangeError = typeof pageIds === 'string' ? pageIds : null;
  const count = typeof pageIds === 'string' ? 0 : pageIds.length;
  const running = status.kind === 'running';

  const chooseFormat = (f: ExportFormatId) => {
    setFormat(f);
    setScale(defaultScaleFor(f));
  };

  const run = async (allowFallbackFonts = false) => {
    if (typeof pageIds === 'string' || summary.limitWarning) return;
    setStatus({ kind: 'running', done: 0, total: pageIds.length });
    try {
      const result = await exporter(doc, {
        format,
        scale,
        pageIds,
        quality,
        env: services.getRenderEnv(),
        allowFallbackFonts,
        canvasLimits: limits,
        onProgress: (done, total) => setStatus({ kind: 'running', done, total }),
      });
      download(result.data, result.filename, result.mimeType);
      setStatus({ kind: 'idle' });
      toast.success(`Downloaded ${result.filename}`);
      onClose();
    } catch (e) {
      if (e instanceof FontLoadError) {
        setStatus({ kind: 'error', message: `Some fonts could not be loaded (${e.missing.join(', ')}). The export would use fallback fonts.`, fontFailure: true });
      } else if (e instanceof AssetLoadError) {
        setStatus({ kind: 'error', message: `An image in this design could not be loaded (asset ${e.assetId}). Replace or remove it, then try again.` });
      } else if (e instanceof CanvasLimitError) {
        setStatus({ kind: 'error', message: `${e.message}. Choose a smaller scale.` });
      } else {
        setStatus({ kind: 'error', message: errorMessage(e) });
      }
    }
  };

  const fileHint =
    format === 'pdf'
      ? `One PDF with ${count} page${count === 1 ? '' : 's'}`
      : count > 1
        ? `A ZIP with ${count} ${format.toUpperCase()} files`
        : `One ${format.toUpperCase()} file`;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Download"
      description={doc.meta.title || 'Untitled design'}
      size="md"
      dismissible={!running}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={running}>
            Cancel
          </Button>
          <Button variant="primary" icon="download" busy={running} disabled={!!rangeError || !!summary.limitWarning || count === 0} onClick={() => void run(false)} data-autofocus="">
            Download
          </Button>
        </>
      }
    >
      <div className="export">
        <fieldset className="export__group" disabled={running}>
          <legend className="export__legend">File type</legend>
          <div className="format-grid" role="radiogroup" aria-label="File type">
            {FORMAT_OPTIONS.map((f) => (
              <label key={f.value} className={cx('format-opt', format === f.value && 'is-checked')}>
                <input type="radio" name="export-format" value={f.value} checked={format === f.value} onChange={() => chooseFormat(f.value)} />
                <span className="format-opt__label">{f.label}</span>
                <span className="format-opt__desc">{f.description}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="export__group" disabled={running}>
          <legend className="export__legend">Size</legend>
          <div className="scale-row" role="radiogroup" aria-label="Size">
            {SCALE_OPTIONS.map((s) => (
              <label key={s.value} className={cx('scale-opt', scale === s.value && 'is-checked')}>
                <input type="radio" name="export-scale" value={s.value} checked={scale === s.value} onChange={() => setScale(s.value)} />
                <span>{s.label}</span>
              </label>
            ))}
          </div>
          <p className="export__dims" data-testid="export-dimensions">
            <Icon name="image" size={16} /> {summary.pixels}
            {scale === 'print' ? ' · 300 dpi' : ''}
          </p>
          {summary.pdfPage && <p className="export__sub">PDF page: {summary.pdfPage}</p>}
          {summary.limitWarning && <Notice tone="warning">{summary.limitWarning}</Notice>}
        </fieldset>

        {format === 'jpg' && (
          <fieldset className="export__group" disabled={running}>
            <legend className="sr-only">JPG quality</legend>
            <Slider label="Quality" value={quality} min={0.5} max={1} step={1} displayScale={100} suffix="%" onChange={setQuality} />
          </fieldset>
        )}

        {pageCount > 1 && (
          <fieldset className="export__group" disabled={running}>
            <legend className="export__legend">Pages</legend>
            <div className="pages-sel">
              <label className="radio">
                <input type="radio" name="export-pages" checked={pages === 'all'} onChange={() => setPages('all')} />
                <span>All pages ({pageCount})</span>
              </label>
              <label className="radio">
                <input type="radio" name="export-pages" checked={pages === 'current'} onChange={() => setPages('current')} />
                <span>Current page ({doc.pages.findIndex((p) => p.id === activePageId) + 1})</span>
              </label>
              <label className="radio">
                <input type="radio" name="export-pages" checked={pages === 'range'} onChange={() => setPages('range')} />
                <span>Pages</span>
              </label>
              <input
                id={rangeId}
                className={cx('input pages-sel__range', pages === 'range' && rangeError && 'is-invalid')}
                aria-label="Page range"
                aria-invalid={pages === 'range' && !!rangeError}
                placeholder="e.g. 1-3, 5"
                value={range}
                onFocus={() => setPages('range')}
                onChange={(e) => {
                  setRange(e.target.value);
                  setPages('range');
                }}
              />
            </div>
            {pages === 'range' && rangeError && <p className="field__error">{rangeError}</p>}
          </fieldset>
        )}

        <p className="export__sub">{fileHint}</p>

        {status.kind === 'running' && <ProgressBar value={status.total ? status.done / status.total : null} label={`Exporting page ${Math.min(status.done + 1, status.total)} of ${status.total}`} />}
        {status.kind === 'running' && (
          <p className="export__sub" aria-live="polite">
            Rendering page {Math.min(status.done + 1, status.total)} of {status.total}…
          </p>
        )}
        {status.kind === 'error' && (
          <Notice tone="error">
            {status.message}
            {status.fontFailure && (
              <div className="notice__actions">
                <Button size="sm" onClick={() => void run(true)}>
                  Export with fallback fonts
                </Button>
              </div>
            )}
          </Notice>
        )}
      </div>
    </Dialog>
  );
}

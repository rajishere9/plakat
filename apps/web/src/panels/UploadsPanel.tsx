/**
 * Uploads flyout: drag & drop or pick images, upload with progress, then click a
 * thumbnail to insert it. Shows this session's uploads plus the images already in the
 * design's asset registry.
 */
import { useMemo, useRef, useState, type DragEvent, type JSX } from 'react';
import { useStore } from 'zustand';
import type { Asset, Id } from '@plakat/schema';
import { useEd, useServices, useStoreApi } from '../app/services.tsx';
import { errorMessage, toast } from '../app/toasts.tsx';
import { Icon } from '../components/Icon.tsx';
import { Button, IconButton, ProgressBar, cx } from '../components/ui.tsx';
import { IMAGE_ACCEPT } from '../lib/images.ts';
import { PanelShell } from './PanelShell.tsx';
import { imageFilesOf, removeUploadItem, uploadImageFile, uploadsStore, type UploadItem } from './uploads.ts';

interface GridEntry {
  key: string;
  src: string;
  name: string;
  width: number;
  height: number;
  assetId?: Id;
  item?: UploadItem;
}

export function UploadsPanel({ onClose }: { onClose?: () => void }): JSX.Element {
  const services = useServices();
  const store = useStoreApi();
  const items = useStore(uploadsStore, (s) => s.items);
  const assets = useEd((s) => s.document.assets);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (files: File[]) => {
    await Promise.all(
      files.map((f) =>
        uploadImageFile(f, services.api).catch((e) => {
          toast.error('Upload failed', { detail: errorMessage(e) });
        }),
      ),
    );
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = imageFilesOf(e.dataTransfer.files);
    if (files.length) void upload(files);
  };

  const pending = items.filter((it) => it.status !== 'done');
  const grid = useMemo<GridEntry[]>(() => {
    const out: GridEntry[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      if (it.status !== 'done' || !it.asset || seen.has(it.asset.src)) continue;
      seen.add(it.asset.src);
      out.push({ key: it.id, src: it.asset.src, name: it.asset.name || it.name, width: it.asset.width, height: it.asset.height, item: it });
    }
    for (const [id, a] of Object.entries(assets) as [Id, Asset][]) {
      if (seen.has(a.src)) continue;
      seen.add(a.src);
      out.push({ key: id, src: a.src, name: a.name, width: a.width, height: a.height, assetId: id });
    }
    return out;
  }, [items, assets]);

  const insert = (g: GridEntry) => {
    const { actions, document } = store.getState();
    const existing = g.assetId ?? Object.entries(document.assets).find(([, a]) => a.src === g.src)?.[0];
    if (existing) actions.addImage({ assetId: existing });
    else if (g.item?.asset) actions.addImage(g.item.asset);
  };

  return (
    <PanelShell title="Uploads" onClose={onClose}>
      <div
        className={cx('dropzone', dragOver && 'is-over')}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
      >
        <Icon name="uploads" size={28} />
        <p className="dropzone__title">Drag images here</p>
        <p className="dropzone__sub">PNG, JPEG, WebP, GIF or SVG · up to 25 MB</p>
        <Button variant="primary" icon="upload" onClick={() => inputRef.current?.click()}>
          Upload files
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept={IMAGE_ACCEPT}
          multiple
          hidden
          aria-label="Choose images to upload"
          onChange={(e) => {
            const files = imageFilesOf(e.target.files);
            e.target.value = '';
            if (files.length) void upload(files);
          }}
        />
      </div>

      {pending.length > 0 && (
        <ul className="upload-list" aria-label="Uploads in progress">
          {pending.map((it) => (
            <li key={it.id} className={cx('upload-row', it.status === 'error' && 'is-error')}>
              <div className="upload-row__name" title={it.name}>
                {it.name}
              </div>
              {it.status === 'error' ? (
                <div className="upload-row__error">{it.error}</div>
              ) : (
                <ProgressBar value={it.status === 'processing' ? null : it.progress} label={`Uploading ${it.name}`} />
              )}
              {it.status === 'error' && <IconButton label={`Dismiss ${it.name}`} icon="close" size="sm" onClick={() => removeUploadItem(it.id)} />}
            </li>
          ))}
        </ul>
      )}

      <h3 className="panel__section-title">Your images</h3>
      {grid.length === 0 ? (
        <p className="panel__hint">Images you upload, and images already in this design, appear here.</p>
      ) : (
        <div className="media-grid">
          {grid.map((g) => (
            <button key={g.key} type="button" className="media-tile" onClick={() => insert(g)} aria-label={`Insert ${g.name || 'image'}`} title={g.name || undefined}>
              <img src={g.src} alt="" loading="lazy" draggable={false} style={{ aspectRatio: `${g.width} / ${g.height}` }} />
            </button>
          ))}
        </div>
      )}
    </PanelShell>
  );
}

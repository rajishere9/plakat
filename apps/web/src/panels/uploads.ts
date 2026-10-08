/**
 * Upload pipeline shared by the Uploads panel, image replacement, brand logos and
 * pasted/dropped files: validate → normalizeUploadFile (bakes EXIF orientation,
 * downsizes > 6000 px) → POST /api/uploads with progress → AssetInput.
 * Session uploads are kept in a small store so the panel can be closed and reopened.
 */
import { createStore } from 'zustand/vanilla';
import { uploadToAssetInput, type ApiClient } from '../api/index.ts';
import { detectImageMime, MAX_UPLOAD_BYTES, normalizeUploadFile } from '../lib/images.ts';
import { formatBytes } from '../app/format.ts';

export type UploadedAsset = ReturnType<typeof uploadToAssetInput>;

export interface UploadItem {
  id: string;
  name: string;
  status: 'processing' | 'uploading' | 'done' | 'error';
  /** 0..1 */
  progress: number;
  error?: string;
  asset?: UploadedAsset;
}

export const uploadsStore = createStore<{ items: UploadItem[] }>()(() => ({ items: [] }));

let seq = 0;
const patch = (id: string, p: Partial<UploadItem>) =>
  uploadsStore.setState((s) => ({ items: s.items.map((it) => (it.id === id ? { ...it, ...p } : it)) }));

export class UploadRejectedError extends Error {
  override name = 'UploadRejectedError';
}

/** Validates a file before any work: supported image type and size limit. */
export function checkUploadFile(file: File): string | null {
  if (!detectImageMime(file)) return `“${file.name}” is not a supported image (PNG, JPEG, WebP, GIF or SVG).`;
  if (file.size > MAX_UPLOAD_BYTES) return `“${file.name}” is ${formatBytes(file.size)}; the limit is ${formatBytes(MAX_UPLOAD_BYTES)}.`;
  return null;
}

/** Uploads one file, tracking it in uploadsStore (unless `track: false`). Rejects on failure. */
export async function uploadImageFile(file: File, api: Pick<ApiClient, 'upload'>, options: { track?: boolean } = {}): Promise<UploadedAsset> {
  const track = options.track !== false;
  const id = `up_${++seq}`;
  if (track) uploadsStore.setState((s) => ({ items: [{ id, name: file.name, status: 'processing', progress: 0 }, ...s.items] }));
  try {
    const problem = checkUploadFile(file);
    if (problem) throw new UploadRejectedError(problem);
    const normalized = await normalizeUploadFile(file);
    if (track) patch(id, { status: 'uploading' });
    const res = await api.upload(normalized.file, {
      filename: file.name,
      onProgress: track ? (f) => patch(id, { progress: f }) : undefined,
    });
    const asset = uploadToAssetInput(res, file.name.replace(/\.[a-z0-9]+$/i, ''));
    if (track) patch(id, { status: 'done', progress: 1, asset });
    return asset;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (track) patch(id, { status: 'error', error: message });
    throw e;
  }
}

export function removeUploadItem(id: string): void {
  uploadsStore.setState((s) => ({ items: s.items.filter((it) => it.id !== id) }));
}

/** Image files from a DataTransfer / FileList. */
export function imageFilesOf(list: FileList | readonly File[] | null | undefined): File[] {
  if (!list) return [];
  return [...list].filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name));
}

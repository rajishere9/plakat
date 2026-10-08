/** Triggers a browser download for a Blob / bytes. */
import type { ExportData } from '@plakat/renderer';

export function toDownloadBlob(data: ExportData | string, mimeType: string): Blob {
  if (typeof data === 'string') return new Blob([data], { type: mimeType });
  return data instanceof Blob ? data : new Blob([data as unknown as BlobPart], { type: mimeType });
}

/** Saves `data` as `filename` via a temporary object URL + <a download>. */
export function downloadBlob(data: ExportData | string, filename: string, mimeType = 'application/octet-stream'): void {
  const blob = toDownloadBlob(data, mimeType);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser time to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

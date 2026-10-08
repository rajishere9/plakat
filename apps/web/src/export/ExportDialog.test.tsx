// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FontLoadError } from '@plakat/renderer';
import { createDocument, PAGE_PRESETS, SAFARI_CANVAS_LIMITS, type PresetId } from '@plakat/schema';
import { createTestServices, renderWithServices } from '../app/test-utils.tsx';
import { ExportDialog } from './ExportDialog.tsx';
import { exportSummary, parsePageRange, resolvePageIds } from './export-options.ts';

afterEach(cleanup);

/** §4.1 of docs/render-export-pipeline.md. */
const EXPECTED: Record<string, { '1x': string; '2x': string; print: string }> = {
  'instagram-post': { '1x': '1080 × 1080 px', '2x': '2160 × 2160 px', print: '3375 × 3375 px' },
  'instagram-story': { '1x': '1080 × 1920 px', '2x': '2160 × 3840 px', print: '3375 × 6000 px' },
  'youtube-thumbnail': { '1x': '1280 × 720 px', '2x': '2560 × 1440 px', print: '4000 × 2250 px' },
  'a4-poster': { '1x': '794 × 1123 px', '2x': '1587 × 2245 px', print: '2480 × 3508 px' },
  'business-card': { '1x': '336 × 192 px', '2x': '672 × 384 px', print: '1050 × 600 px' },
  'business-card-eu': { '1x': '321 × 208 px', '2x': '643 × 416 px', print: '1004 × 650 px' },
};

function open(preset: PresetId, pageCount = 1, exporter = vi.fn(), download = vi.fn()) {
  const services = createTestServices({ document: createDocument(preset, { pageCount, title: 'My Poster' }) });
  renderWithServices(<ExportDialog open onClose={() => {}} exporter={exporter} download={download} />, services);
  return { services, exporter, download };
}

const dims = () => screen.getByTestId('export-dimensions').textContent ?? '';

describe('ExportDialog', () => {
  it.each(PAGE_PRESETS.map((p) => p.id))('shows the exact output pixels for %s at 1x / 2x / print', (id) => {
    open(id);
    const want = EXPECTED[id]!;
    expect(dims()).toContain(want['1x']);
    fireEvent.click(screen.getByRole('radio', { name: '2×' }));
    expect(dims()).toContain(want['2x']);
    fireEvent.click(screen.getByRole('radio', { name: 'Print (300 dpi)' }));
    expect(dims()).toContain(want.print);
    expect(dims()).toContain('300 dpi');
  });

  it('labels PDF as an image PDF, defaults it to print scale and shows the PDF page size', () => {
    open('a4-poster');
    fireEvent.click(screen.getByRole('radio', { name: /PDF \(image, 300 dpi\)/ }));
    expect((screen.getByRole('radio', { name: 'Print (300 dpi)' }) as HTMLInputElement).checked).toBe(true);
    expect(dims()).toContain('2480 × 3508 px');
    expect(screen.getByText(/PDF page: 210 × 297 mm \(595\.28 × 841\.89 pt\)/)).toBeTruthy();
  });

  it('shows the JPG quality slider only for JPG', () => {
    open('instagram-post');
    expect(screen.queryByText('Quality')).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /JPG/ }));
    expect(screen.getByText('Quality')).toBeTruthy();
  });

  it('exports the chosen pages with the chosen options and triggers the download', async () => {
    const blob = new Blob(['x']);
    const exporter = vi.fn(async (_doc: unknown, opts: { onProgress?: (d: number, t: number) => void }) => {
      opts.onProgress?.(1, 2);
      opts.onProgress?.(2, 2);
      return { filename: 'my-poster.zip', mimeType: 'application/zip', data: blob };
    });
    const { services, download } = open('instagram-post', 3, exporter as never);
    const doc = services.store.getState().document;
    fireEvent.click(screen.getByRole('radio', { name: /JPG/ }));
    fireEvent.click(screen.getByRole('radio', { name: '2×' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Page range' }), { target: { value: '1, 3' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });
    await waitFor(() => expect(download).toHaveBeenCalledWith(blob, 'my-poster.zip', 'application/zip'));
    expect(exporter).toHaveBeenCalledWith(
      doc,
      expect.objectContaining({ format: 'jpg', scale: '2x', pageIds: [doc.pages[0]!.id, doc.pages[2]!.id], allowFallbackFonts: false }),
    );
  });

  it('offers a fallback-font retry when fonts fail to load', async () => {
    const exporter = vi.fn().mockRejectedValueOnce(new FontLoadError(['"Inter" normal 700'])).mockResolvedValueOnce({ filename: 'a.png', mimeType: 'image/png', data: new Blob() });
    open('instagram-post', 1, exporter);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    });
    expect(await screen.findByText(/Some fonts could not be loaded/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Export with fallback fonts' }));
    });
    expect(exporter).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ allowFallbackFonts: true }));
  });

  it('rejects invalid page ranges', () => {
    open('instagram-post', 2);
    fireEvent.change(screen.getByRole('textbox', { name: 'Page range' }), { target: { value: '5' } });
    expect(screen.getByText('Pages go from 1 to 2')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('export options', () => {
  it('parses page ranges', () => {
    expect(parsePageRange('1-3, 5', 6)).toEqual([1, 2, 3, 5]);
    expect(parsePageRange('3-1 2', 3)).toEqual([1, 2, 3]);
    expect(parsePageRange('', 3)).toMatch(/Enter pages/);
    expect(parsePageRange('2-x', 3)).toMatch(/not a page/);
    expect(parsePageRange('0', 3)).toMatch(/1 to 3/);
  });

  it('resolves page selections to ids', () => {
    const doc = createDocument('instagram-post', { pageCount: 3 });
    const ids = doc.pages.map((p) => p.id);
    expect(resolvePageIds(doc, 'all', ids[1]!, '')).toEqual(ids);
    expect(resolvePageIds(doc, 'current', ids[1]!, '')).toEqual([ids[1]]);
    expect(resolvePageIds(doc, 'range', ids[0]!, '2-3')).toEqual([ids[1], ids[2]]);
  });

  it('warns when the bitmap exceeds the canvas limits (Safari story at print)', () => {
    const doc = createDocument('instagram-story');
    expect(exportSummary(doc.size, 'png', 'print').limitWarning).toBeNull();
    expect(exportSummary(doc.size, 'png', 'print', SAFARI_CANVAS_LIMITS).limitWarning).toMatch(/exceeds the maximum canvas area/);
    expect(exportSummary(doc.size, 'png', '2x', SAFARI_CANVAS_LIMITS).limitWarning).toBeNull();
  });
});

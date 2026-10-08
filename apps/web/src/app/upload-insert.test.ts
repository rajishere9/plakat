// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeStore, page0 } from '../store/test-helpers.ts';
import { toastStore } from './toasts.tsx';

const upload = vi.fn();
vi.mock('../panels/uploads.ts', async (orig) => ({
  ...(await orig<typeof import('../panels/uploads.ts')>()),
  uploadImageFile: (f: File) => upload(f),
}));

const { uploadAndInsert } = await import('./Editor.tsx');

const png = (name: string) => new File([new Uint8Array([1, 2, 3])], name, { type: 'image/png' });
const asset = { src: 'data:image/png;base64,iVBORw0KGgo=', width: 10, height: 10, mimeType: 'image/png' as const };

describe('uploadAndInsert', () => {
  beforeEach(() => {
    upload.mockReset();
    toastStore.setState({ toasts: [] });
  });

  it('shows no success toast when every upload failed', async () => {
    upload.mockRejectedValue(new Error('The source image could not be decoded.'));
    const { store } = makeStore();
    await uploadAndInsert([png('broken.png')], { store, api: {} as never });
    const toasts = toastStore.getState().toasts;
    expect(toasts.map((t) => t.kind)).toEqual(['error']);
    expect(toasts[0]!.message).toBe('Upload failed');
    expect(page0(store).elements).toHaveLength(0);
  });

  it('counts only the uploads that succeeded', async () => {
    upload.mockImplementation(async (f: File) => {
      if (f.name === 'bad.png') throw new Error('nope');
      return asset;
    });
    const { store } = makeStore();
    await uploadAndInsert([png('a.png'), png('bad.png'), png('c.png')], { store, api: {} as never });
    const toasts = toastStore.getState().toasts;
    expect(toasts.find((t) => t.kind === 'success')?.message).toBe('2 images added');
    expect(toasts.some((t) => t.kind === 'info')).toBe(false);
    expect(page0(store).elements).toHaveLength(2);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { detectImageMime, fitWithin, normalizeUploadFile, readJpegOrientation, readSvgSize, UnsupportedImageError, type ImageCodec } from './images.ts';

function jpegWithOrientation(orientation: number, little = false): Uint8Array<ArrayBuffer> {
  const tiff = little
    ? [0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, orientation, 0x00, 0x00, 0x00, 0, 0, 0, 0]
    : [0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, 0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0, 0, 0, 0];
  const app1 = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...tiff];
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xe1, len >> 8, len & 0xff, ...app1, 0xff, 0xda, 0x00, 0x02]);
}

function fakeCodec(width: number, height: number) {
  const close = vi.fn();
  const codec: ImageCodec = {
    decode: vi.fn(async () => ({ width, height, source: {} as CanvasImageSource, close })),
    encode: vi.fn(async (_s, _w, _h, type) => new Blob([new Uint8Array([1, 2, 3])], { type })),
  };
  return { codec, close };
}

describe('readJpegOrientation', () => {
  it('reads big- and little-endian EXIF orientation', () => {
    expect(readJpegOrientation(jpegWithOrientation(6))).toBe(6);
    expect(readJpegOrientation(jpegWithOrientation(8, true))).toBe(8);
    expect(readJpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda]))).toBe(1);
    expect(readJpegOrientation(new Uint8Array([0x89, 0x50]))).toBe(1);
  });
});

describe('readSvgSize', () => {
  it('reads width/height, units, and viewBox fallbacks', () => {
    expect(readSvgSize('<svg width="120" height="80px"></svg>')).toEqual({ width: 120, height: 80 });
    expect(readSvgSize('<svg viewBox="0 0 300 150"/>')).toEqual({ width: 300, height: 150 });
    expect(readSvgSize('<svg width="600" viewBox="0 0 300 150"/>')).toEqual({ width: 600, height: 300 });
    expect(readSvgSize('<svg width="1in" height="2in"/>')).toEqual({ width: 96, height: 192 });
    expect(readSvgSize('<svg width="100%"/>')).toBeNull();
  });
});

describe('normalizeUploadFile', () => {
  it('passes through images that need no change', async () => {
    const { codec, close } = fakeCodec(800, 600);
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' });
    const r = await normalizeUploadFile(file, { codec });
    expect(r).toMatchObject({ file, mimeType: 'image/png', width: 800, height: 600, transformed: false });
    expect(codec.encode).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('bakes EXIF orientation of JPEGs (decoded size is the oriented size)', async () => {
    const { codec } = fakeCodec(600, 800);
    const file = new File([jpegWithOrientation(6)], 'photo.jpeg', { type: 'image/jpeg' });
    const r = await normalizeUploadFile(file, { codec });
    expect(r).toMatchObject({ mimeType: 'image/jpeg', width: 600, height: 800, transformed: true, orientation: 6 });
    expect(r.file.name).toBe('photo.jpg');
    expect(codec.encode).toHaveBeenCalledWith(expect.anything(), 600, 800, 'image/jpeg', 0.92);
  });

  it('downscales above maxSide keeping the aspect', async () => {
    const { codec } = fakeCodec(12000, 3000);
    const file = new File([new Uint8Array([1])], 'wide.webp', { type: 'image/webp' });
    const r = await normalizeUploadFile(file, { codec });
    expect(r).toMatchObject({ width: 6000, height: 1500, transformed: true, mimeType: 'image/webp' });
  });

  it('never re-encodes SVG/GIF and rejects other types', async () => {
    const { codec } = fakeCodec(10, 10);
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"></svg>'], 'x.svg', { type: 'image/svg+xml' });
    expect(await normalizeUploadFile(svg, { codec })).toMatchObject({ file: svg, width: 40, height: 30, transformed: false });
    const gif = new File([new Uint8Array([0x47, 0x49, 0x46])], 'x.gif', { type: '' });
    expect(await normalizeUploadFile(gif, { codec })).toMatchObject({ file: gif, mimeType: 'image/gif', width: 10, transformed: false });
    await expect(normalizeUploadFile(new File(['x'], 'x.txt', { type: 'text/plain' }), { codec })).rejects.toBeInstanceOf(UnsupportedImageError);
  });
});

describe('helpers', () => {
  it('detectImageMime and fitWithin', () => {
    expect(detectImageMime({ type: '', name: 'A.JPG' })).toBe('image/jpeg');
    expect(detectImageMime({ type: 'image/jpg' })).toBe('image/jpeg');
    expect(detectImageMime({ type: 'application/pdf', name: 'a.pdf' })).toBeNull();
    expect(fitWithin(7000, 7000, 6000)).toEqual({ width: 6000, height: 6000, scaled: true });
    expect(fitWithin(10, 20, 6000)).toEqual({ width: 10, height: 20, scaled: false });
  });
});

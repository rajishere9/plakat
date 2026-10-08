import { describe, expect, it } from 'vitest';
import { makeGif, makeJpeg, makePng, makeWebpVp8, makeWebpVp8l, makeWebpVp8x } from '../test-utils.ts';
import { parseSvgLength, readImageInfo, sniffImageType, SVG_FALLBACK_SIZE } from './dimensions.ts';

const svg = (s: string) => Buffer.from(s, 'utf8');

describe('raster header parsers', () => {
  it('PNG', () => {
    expect(readImageInfo(makePng(37, 12))).toEqual({ mimeType: 'image/png', width: 37, height: 12 });
  });

  it('JPEG (baseline and progressive SOF)', () => {
    expect(readImageInfo(makeJpeg(640, 480))).toEqual({ mimeType: 'image/jpeg', width: 640, height: 480 });
    expect(readImageInfo(makeJpeg(1, 65535, { progressive: true }))).toEqual({ mimeType: 'image/jpeg', width: 1, height: 65535 });
  });

  it('JPEG honours EXIF orientation (5..8 swap, both byte orders)', () => {
    expect(readImageInfo(makeJpeg(640, 480, { orientation: 6 }))).toMatchObject({ width: 480, height: 640 });
    expect(readImageInfo(makeJpeg(640, 480, { orientation: 8, littleEndian: true }))).toMatchObject({ width: 480, height: 640 });
    expect(readImageInfo(makeJpeg(640, 480, { orientation: 3 }))).toMatchObject({ width: 640, height: 480 });
  });

  it('WebP VP8 / VP8L / VP8X', () => {
    expect(readImageInfo(makeWebpVp8(300, 200))).toEqual({ mimeType: 'image/webp', width: 300, height: 200 });
    expect(readImageInfo(makeWebpVp8l(16383, 1))).toEqual({ mimeType: 'image/webp', width: 16383, height: 1 });
    expect(readImageInfo(makeWebpVp8l(1, 16384))).toEqual({ mimeType: 'image/webp', width: 1, height: 16384 });
    expect(readImageInfo(makeWebpVp8x(70000, 3))).toEqual({ mimeType: 'image/webp', width: 70000, height: 3 });
  });

  it('GIF', () => {
    expect(readImageInfo(makeGif(500, 260))).toEqual({ mimeType: 'image/gif', width: 500, height: 260 });
  });

  it('rejects truncated / unknown data', () => {
    expect(readImageInfo(makePng(10, 10).subarray(0, 20))).toBeNull();
    expect(readImageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
    expect(readImageInfo(Buffer.from('hello world'))).toBeNull();
    expect(readImageInfo(Buffer.from('<html><svg width="1" height="1"></svg></html>'))).toBeNull();
    expect(readImageInfo(new Uint8Array())).toBeNull();
    expect(readImageInfo(makeGif(0, 10))).toBeNull();
  });
});

describe('SVG', () => {
  it('reads width/height with units', () => {
    expect(readImageInfo(svg('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40px"/>'))).toEqual({
      mimeType: 'image/svg+xml',
      width: 120,
      height: 40,
    });
    expect(readImageInfo(svg(`<svg width='1in' height='25.4mm'></svg>`))).toMatchObject({ width: 96, height: 96 });
  });

  it('falls back to the viewBox, deriving a missing side from its aspect', () => {
    expect(readImageInfo(svg('<svg viewBox="0 0 200 100"></svg>'))).toMatchObject({ width: 200, height: 100 });
    expect(readImageInfo(svg('<svg width="50" viewBox="0,0,200,100"></svg>'))).toMatchObject({ width: 50, height: 25 });
    expect(readImageInfo(svg('<svg width="100%" height="100%" viewBox="0 0 30 60"></svg>'))).toMatchObject({ width: 30, height: 60 });
  });

  it('skips XML declaration, comments, doctype and BOM', () => {
    const text =
      '﻿<?xml version="1.0"?>\n<!-- a > comment -->\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x" [ <!ENTITY a "b"> ]>\n<svg data-x="a>b" width="10" height="20"><g/></svg>';
    expect(readImageInfo(svg(text))).toMatchObject({ mimeType: 'image/svg+xml', width: 10, height: 20 });
  });

  it('uses the browser default size when nothing is declared', () => {
    expect(readImageInfo(svg('<svg></svg>'))).toMatchObject(SVG_FALLBACK_SIZE);
  });

  it('parses lengths', () => {
    expect(parseSvgLength('12.5')).toBe(12.5);
    expect(parseSvgLength('3pt')).toBe(4);
    expect(parseSvgLength('2em')).toBeNull();
    expect(parseSvgLength('-5')).toBeNull();
    expect(parseSvgLength('0')).toBeNull();
  });

  it('sniffs by root element, not by extension or content-type', () => {
    expect(sniffImageType(svg('<svg/>'))).toBe('image/svg+xml');
    expect(sniffImageType(svg('<svgx/>'))).toBeNull();
    expect(sniffImageType(svg('<!-- unterminated'))).toBeNull();
  });
});

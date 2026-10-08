import { describe, expect, it } from 'vitest';
import { allowedAssetSrc } from './render-env.ts';

const ORIGIN = 'https://plakat.example';

describe('allowedAssetSrc (P-4 editor src policy)', () => {
  it('allows data:image URIs and same-origin /uploads/ files', () => {
    const data = 'data:image/png;base64,iVBORw0KGgo=';
    expect(allowedAssetSrc(data, ORIGIN)).toBe(data);
    expect(allowedAssetSrc('DATA:image/svg+xml,%3Csvg%2F%3E', ORIGIN)).toBe('DATA:image/svg+xml,%3Csvg%2F%3E');
    expect(allowedAssetSrc('/uploads/abc.png', ORIGIN)).toBe('/uploads/abc.png');
    expect(allowedAssetSrc(`${ORIGIN}/uploads/abc.webp`, ORIGIN)).toBe('/uploads/abc.webp');
  });

  it('refuses remote, cross-origin, non-upload and escaping srcs (drawn as missing)', () => {
    for (const src of [
      'https://evil.example/a.png',
      'http://plakat.example/uploads/a.png', // other scheme = other origin
      '//evil.example/uploads/a.png',
      '/\\evil.example/uploads/a.png',
      '/api/projects/doc_1/thumbnail',
      '/uploads/../api/projects',
      '/uploads/%2e%2e/api/projects',
      '/uploadsX/a.png',
      'uploads/a.png', // relative to the page path, not /uploads/
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'blob:https://plakat.example/123',
      `https://user:pw@plakat.example/uploads/a.png`,
    ]) {
      expect(allowedAssetSrc(src, ORIGIN), src).toBeNull();
    }
  });

  it('only allows data: URIs without a known origin', () => {
    expect(allowedAssetSrc('/uploads/a.png', null)).toBeNull();
    expect(allowedAssetSrc('/uploads/a.png', 'null')).toBeNull();
    expect(allowedAssetSrc('data:image/gif;base64,R0lGODlh', null)).toBe('data:image/gif;base64,R0lGODlh');
  });
});

import { describe, expect, it } from 'vitest';
import { PAGE_PRESETS } from '@plakat/schema';
import { categoryLabel, formatPageSize, formatRelativeTime } from './format.ts';
import { presetSizeLabel } from './Home.tsx';
import { parseRoute, routeToHash } from './router.ts';
import { previewScale } from './preview.ts';

describe('router', () => {
  it('parses hashes', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('#/design/abc_123')).toEqual({ name: 'design', id: 'abc_123' });
    expect(parseRoute('#/design/abc/')).toEqual({ name: 'design', id: 'abc' });
    expect(parseRoute('#/template/tpl%20x')).toEqual({ name: 'template', id: 'tpl x' });
    expect(parseRoute('#/nope')).toEqual({ name: 'notFound', path: '/nope' });
    expect(parseRoute('#/design/%E0%A4%A')).toMatchObject({ name: 'notFound' });
  });

  it('round-trips routes', () => {
    for (const r of [{ name: 'home' }, { name: 'design', id: 'd 1' }, { name: 'template', id: 't/1' }] as const) {
      expect(parseRoute(routeToHash(r))).toEqual(r);
    }
  });
});

describe('format', () => {
  it('labels preset sizes, physical first for print', () => {
    const label = (id: string) => presetSizeLabel(PAGE_PRESETS.find((p) => p.id === id)!);
    expect(label('instagram-post')).toEqual({ primary: '1080 × 1080 px', secondary: null });
    expect(label('a4-poster')).toEqual({ primary: '210 × 297 mm', secondary: '794 × 1123 px' });
    expect(label('business-card')).toEqual({ primary: '3.5 × 2 in', secondary: '336 × 192 px' });
    expect(label('business-card-eu')).toEqual({ primary: '85 × 55 mm', secondary: '321 × 208 px' });
    expect(formatPageSize({ width: 1280, height: 720, physical: null })).toBe('1280 × 720 px');
  });

  it('humanizes categories and times', () => {
    expect(categoryLabel('youtube-thumbnail')).toBe('YouTube thumbnail');
    expect(categoryLabel('instagram-post')).toBe('Instagram post');
    expect(categoryLabel(null)).toBe('Uncategorized');
    const now = new Date('2026-10-08T12:00:00Z');
    expect(formatRelativeTime('2026-10-08T11:59:50Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-10-08T11:30:00Z', now)).toBe('30 min ago');
    expect(formatRelativeTime('2026-10-07T12:00:00Z', now)).toBe('yesterday');
  });

  it('fits previews into a max side (capped at 2x)', () => {
    expect(previewScale({ width: 1080, height: 1920 }, 480)).toBeCloseTo(0.25);
    expect(previewScale({ width: 100, height: 50 }, 480)).toBe(2);
  });
});

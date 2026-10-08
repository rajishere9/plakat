// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_FONTS_CATALOG } from '@plakat/schema';
import { filterFontOptions, FontPicker } from '../components/FontPicker.tsx';

afterEach(cleanup);

describe('filterFontOptions', () => {
  it('lists brand fonts, then document fonts, then the catalog by category', () => {
    const groups = filterFontOptions('', [{ family: 'Montserrat', role: 'Heading' }], ['Lora', 'Montserrat']);
    expect(groups[0]).toMatchObject({ id: 'brand', options: [{ family: 'Montserrat', note: 'Heading' }] });
    expect(groups[1]).toMatchObject({ id: 'document', options: [{ family: 'Lora' }] });
    const catalogCount = groups.slice(2).reduce((n, g) => n + g.options.length, 0);
    expect(catalogCount).toBe(GOOGLE_FONTS_CATALOG.length);
    expect(groups.slice(2).map((g) => g.label)).toContain('Serif');
  });

  it('filters case-insensitively by substring and dedupes results', () => {
    const groups = filterFontOptions('RA', [], ['Raleway']);
    expect(groups.map((g) => g.id)).toEqual(['document', 'results', 'custom']);
    expect(groups[1]!.options.map((o) => o.family)).not.toContain('Raleway');
    expect(groups[1]!.options.map((o) => o.family)).toContain('Montserrat');
    const all = groups.flatMap((g) => g.options.map((o) => o.family.toLowerCase()));
    expect(all.every((f) => f.includes('ra'))).toBe(true);
  });

  it('offers a typed, uncatalogued family as a custom Google font; rejects invalid names', () => {
    expect(filterFontOptions('Bungee Shade').at(-1)).toMatchObject({ id: 'custom', options: [{ family: 'Bungee Shade' }] });
    expect(filterFontOptions('Inter').some((g) => g.id === 'custom')).toBe(false);
    expect(filterFontOptions('<script>').some((g) => g.id === 'custom')).toBe(false);
    expect(filterFontOptions('zzzzqqq').filter((g) => g.id !== 'custom')).toEqual([]);
  });
});

describe('FontPicker', () => {
  it('opens, filters as you type, and picks with the keyboard', () => {
    const onChange = vi.fn();
    render(<FontPicker label="Font" value="Inter" onChange={onChange} brandFonts={[{ family: 'Lato', role: 'Body' }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Font: Inter' }));
    const list = screen.getByRole('listbox', { name: 'Fonts' });
    expect(within(list).getByRole('group', { name: 'Brand fonts' })).toBeTruthy();
    expect(within(list).getAllByRole('option', { name: /Inter/ })[0]!.getAttribute('aria-selected')).toBe('true');

    const search = screen.getByRole('combobox', { name: 'Search fonts' });
    fireEvent.change(search, { target: { value: 'mont' } });
    const options = within(screen.getByRole('listbox')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('Montserrat')]));
    expect(options.every((o) => /mont/i.test(o.textContent ?? ''))).toBe(true);

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowUp' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith(options[0]!.querySelector('.font-opt__name')!.textContent);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('shows an empty state when nothing matches', () => {
    render(<FontPicker label="Font" value={null} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Font: Mixed' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search fonts' }), { target: { value: '###' } });
    expect(screen.getByText(/No fonts match/)).toBeTruthy();
  });
});

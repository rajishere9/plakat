/** Text flyout: heading / subheading / body presets; brand fonts are offered first. */
import { useEffect, type JSX } from 'react';
import type { BrandFont, BrandFontRole } from '@plakat/schema';
import { useEd, useStoreApi } from '../app/services.tsx';
import { ensureFontPreview } from '../lib/fonts.ts';
import { selectActiveBrandKit, type AddTextPreset } from '../store/index.ts';
import { PanelShell } from './PanelShell.tsx';

const ROLE_TO_PRESET: Record<BrandFontRole, AddTextPreset> = { heading: 'heading', subheading: 'subheading', body: 'body', accent: 'subheading' };
export const ROLE_LABELS: Record<BrandFontRole, string> = { heading: 'Heading', subheading: 'Subheading', body: 'Body', accent: 'Accent' };

const PRESETS: { preset: AddTextPreset; label: string; className: string }[] = [
  { preset: 'heading', label: 'Add a heading', className: 'text-preset--heading' },
  { preset: 'subheading', label: 'Add a subheading', className: 'text-preset--subheading' },
  { preset: 'body', label: 'Add a little bit of body text', className: 'text-preset--body' },
];

const fontStyleOf = (f: BrandFont | undefined) =>
  f ? { fontFamily: `"${f.family}", var(--font-ui)`, fontWeight: f.weight, fontStyle: f.style } : undefined;

export function TextPanel({ onClose }: { onClose?: () => void }): JSX.Element {
  const store = useStoreApi();
  const kit = useEd(selectActiveBrandKit);
  const brandFonts = kit?.fonts ?? [];
  const roleFont = (role: BrandFontRole) => brandFonts.find((f) => f.role === role);

  useEffect(() => {
    brandFonts.forEach((f) => ensureFontPreview(f.family));
  }, [brandFonts]);

  const add = (preset: AddTextPreset, font?: BrandFont) => {
    const f = font ?? roleFont(preset);
    store.getState().actions.addText({
      preset,
      ...(f ? { fontFamily: f.family, fontWeight: f.weight, fontStyle: f.style } : {}),
    });
  };

  return (
    <PanelShell title="Text" onClose={onClose}>
      {brandFonts.length > 0 && (
        <>
          <h3 className="panel__section-title">Brand fonts{kit?.name ? ` · ${kit.name}` : ''}</h3>
          <div className="text-presets">
            {brandFonts.map((f) => (
              <button key={f.id} type="button" className="text-brand" onClick={() => add(ROLE_TO_PRESET[f.role], f)} aria-label={`Add ${ROLE_LABELS[f.role].toLowerCase()} text in ${f.family}`}>
                <span className="text-brand__sample" style={fontStyleOf(f)}>
                  {f.family}
                </span>
                <span className="text-brand__role">{ROLE_LABELS[f.role]}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <h3 className="panel__section-title">Default text styles</h3>
      <div className="text-presets">
        {PRESETS.map((p) => (
          <button key={p.preset} type="button" className={`text-preset ${p.className}`} onClick={() => add(p.preset)} style={fontStyleOf(roleFont(p.preset))}>
            {p.label}
          </button>
        ))}
      </div>
      <p className="panel__hint">Double-click text on the canvas to edit it. Press T to add a heading anywhere.</p>
    </PanelShell>
  );
}

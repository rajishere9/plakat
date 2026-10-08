/**
 * Brand flyout: brand kit editor (colors, fonts per role, logos) and "Apply brand to
 * design". Edits are applied to the store immediately and saved to the server
 * (debounced) through brand-sync.ts.
 */
import { useRef, useState, type JSX } from 'react';
import {
  addBrandColor,
  addBrandLogo,
  removeBrandColor,
  removeBrandFont,
  removeBrandLogo,
  setBrandFont,
  type Asset,
  type BrandFontRole,
  type BrandKit,
  type FontWeight,
} from '@plakat/schema';
import { useEd, useServices, useStoreApi } from '../app/services.tsx';
import { errorMessage, toast } from '../app/toasts.tsx';
import { normalizeHex } from '../components/ColorPicker.tsx';
import { FontPicker } from '../components/FontPicker.tsx';
import { Popover } from '../components/Popover.tsx';
import { Menu } from '../components/Menu.tsx';
import { Icon } from '../components/Icon.tsx';
import { Button, EmptyState, IconButton, Select, Spinner } from '../components/ui.tsx';
import { adaptVariantToFamily, availableWeights, FONT_WEIGHT_NAMES } from '../lib/fonts.ts';
import { IMAGE_ACCEPT } from '../lib/images.ts';
import { selectActiveBrandKit } from '../store/index.ts';
import { PanelShell } from './PanelShell.tsx';
import { ROLE_LABELS } from './TextPanel.tsx';
import { createKit, deleteKit, updateKit } from './brand-sync.ts';
import { uploadImageFile } from './uploads.ts';

const ROLES: BrandFontRole[] = ['heading', 'subheading', 'body', 'accent'];

/** "+" swatch that opens a small popover to pick and add a brand color. */
export function BrandColorAdder({ onAdd }: { onAdd: (color: string) => void }): JSX.Element {
  const [open, setOpen] = useState(false);
  const [color, setColor] = useState('#6a46f5');
  const [hex, setHex] = useState('#6a46f5');
  const anchor = useRef<HTMLButtonElement>(null);
  const valid = normalizeHex(hex);
  return (
    <>
      <button ref={anchor} type="button" className="brand-color__swatch brand-color__swatch--add" aria-label="Add brand color" title="Add brand color" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={18} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchor={anchor} label="Add brand color" width={232}>
        <form
          className="brand-adder"
          onSubmit={(e) => {
            e.preventDefault();
            if (!valid) return;
            onAdd(valid);
            setOpen(false);
          }}
        >
          <div className="brand-adder__row">
            <label className="color-native" title="Pick a color" style={{ background: color }}>
              <input
                type="color"
                aria-label="Pick a color"
                value={color}
                onChange={(e) => {
                  setColor(e.target.value);
                  setHex(e.target.value);
                }}
              />
            </label>
            <input
              className="input input--mono"
              aria-label="Hex value"
              value={hex}
              spellCheck={false}
              onChange={(e) => {
                setHex(e.target.value);
                const n = normalizeHex(e.target.value);
                if (n) setColor(n.slice(0, 7));
              }}
            />
          </div>
          <Button type="submit" variant="primary" size="sm" disabled={!valid}>
            Add color
          </Button>
        </form>
      </Popover>
    </>
  );
}

export function BrandPanel({ onClose }: { onClose?: () => void }): JSX.Element {
  const services = useServices();
  const store = useStoreApi();
  const kits = useEd((s) => s.brandKits);
  const kit = useEd(selectActiveBrandKit);
  const selection = useEd((s) => s.selectedIds);
  const docFonts = useEd((s) => s.document.fonts);
  const [busy, setBusy] = useState<string | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);

  const edit = (next: BrandKit) => updateKit(next, services.api, store);
  const guard = (fn: () => void) => {
    try {
      fn();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const newKit = async () => {
    setBusy('create');
    try {
      await createKit(kits.length ? `Brand kit ${kits.length + 1}` : 'My brand', services.api, store);
    } catch (e) {
      toast.error('Could not create a brand kit', { detail: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const removeKit = async (k: BrandKit) => {
    if (!window.confirm(`Delete the brand kit “${k.name}”? This cannot be undone.`)) return;
    try {
      await deleteKit(k.id, services.api, store);
    } catch (e) {
      toast.error('Could not delete the brand kit', { detail: errorMessage(e) });
    }
  };

  const uploadLogos = async (files: File[]) => {
    if (!kit) return;
    setBusy('logo');
    try {
      let next = kit;
      for (const f of files) {
        const up = await uploadImageFile(f, services.api, { track: false });
        const asset: Asset = { type: 'image', mimeType: up.mimeType, width: up.width, height: up.height, src: up.src, name: up.name, source: up.source };
        next = addBrandLogo(next, asset, up.name).kit;
      }
      edit(next);
    } catch (e) {
      toast.error('Logo upload failed', { detail: errorMessage(e) });
    } finally {
      setBusy(null);
    }
  };

  const applyToDesign = () => {
    if (!kit) return;
    store.getState().actions.applyBrandKit(kit.id);
    toast.success(`Applied “${kit.name}” to the design`, { actions: [{ label: 'Undo', onClick: () => store.getState().actions.undo() }] });
  };

  if (!kit) {
    return (
      <PanelShell title="Brand" onClose={onClose}>
        <EmptyState
          icon="brand"
          title="No brand kit yet"
          action={
            <Button variant="primary" icon="plus" busy={busy === 'create'} onClick={() => void newKit()}>
              Create brand kit
            </Button>
          }
        >
          Keep your colors, fonts and logos in one place and apply them to any design in one click.
        </EmptyState>
      </PanelShell>
    );
  }

  return (
    <PanelShell
      title="Brand"
      onClose={onClose}
      header={
        <div className="brand-head">
          {kits.length > 1 ? (
            <Select
              aria-label="Brand kit"
              value={kit.id}
              onChange={(e) => store.getState().actions.setActiveBrandKit(e.target.value)}
              options={kits.map((k) => ({ value: k.id, label: k.name || 'Untitled kit' }))}
            />
          ) : (
            <input className="input brand-head__name" aria-label="Brand kit name" value={kit.name} maxLength={200} onChange={(e) => edit({ ...kit, name: e.target.value })} />
          )}
          <Menu
            label="Brand kit actions"
            placement="bottom-end"
            items={[
              { id: 'new', label: 'New brand kit', icon: 'plus', onSelect: () => void newKit() },
              {
                id: 'rename',
                label: 'Rename…',
                icon: 'edit',
                onSelect: () => {
                  const name = window.prompt('Brand kit name', kit.name);
                  if (name !== null && name.trim()) edit({ ...kit, name: name.trim().slice(0, 200) });
                },
              },
              { id: 'sep', separator: true },
              { id: 'delete', label: 'Delete brand kit', icon: 'trash', danger: true, onSelect: () => void removeKit(kit) },
            ]}
            trigger={(props) => (
              <button {...props} type="button" className="icon-btn icon-btn--md icon-btn--ghost" aria-label="Brand kit actions" title="Brand kit actions">
                <Icon name="more" size={18} />
              </button>
            )}
          />
        </div>
      }
      footer={
        <Button variant="primary" block icon="sparkle" onClick={applyToDesign}>
          Apply brand to design
        </Button>
      }
    >
      <h3 className="panel__section-title">Colors</h3>
      <div className="brand-colors">
        {kit.colors.map((c) => (
          <div key={c.id} className="brand-color">
            <button
              type="button"
              className="brand-color__swatch"
              style={{ background: c.value }}
              aria-label={selection.length ? `Apply ${c.value} to selection` : c.value}
              title={selection.length ? `Apply ${c.value} to selection` : c.value}
              onClick={() => selection.length && store.getState().actions.applyColor(c.value)}
            />
            <button type="button" className="brand-color__remove" aria-label={`Remove color ${c.value}`} onClick={() => edit(removeBrandColor(kit, c.id))}>
              <Icon name="close" size={10} strokeWidth={2.5} />
            </button>
          </div>
        ))}
        <BrandColorAdder onAdd={(c) => guard(() => edit(addBrandColor(kit, c)))} />
      </div>

      <h3 className="panel__section-title">Fonts</h3>
      <div className="brand-fonts">
        {ROLES.map((role) => {
          const f = kit.fonts.find((x) => x.role === role);
          const weights = f ? availableWeights(f.family, f.style) : [];
          return (
            <div key={role} className="brand-font">
              <div className="brand-font__role">{ROLE_LABELS[role]}</div>
              <div className="brand-font__controls">
                <FontPicker
                  label={`${ROLE_LABELS[role]} font`}
                  value={f?.family ?? null}
                  placeholder="Choose a font"
                  documentFonts={docFonts.map((x) => x.family)}
                  onChange={(family) =>
                    guard(() => {
                      const v = adaptVariantToFamily(family, f?.weight ?? (role === 'heading' ? 700 : 400), f?.style ?? 'normal');
                      edit(setBrandFont(kit, { role, family, weight: v.fontWeight, style: v.fontStyle }).kit);
                    })
                  }
                />
                {f && (
                  <>
                    <Select
                      aria-label={`${ROLE_LABELS[role]} font weight`}
                      value={String(f.weight)}
                      onChange={(e) => guard(() => edit(setBrandFont(kit, { role, family: f.family, weight: Number(e.target.value) as FontWeight, style: f.style }).kit))}
                      options={weights.map((w) => ({ value: String(w), label: FONT_WEIGHT_NAMES[w] }))}
                    />
                    <IconButton label={`Remove ${ROLE_LABELS[role].toLowerCase()} font`} icon="close" size="sm" onClick={() => edit(removeBrandFont(kit, f.id))} />
                  </>
                )}
              </div>
              {f && selection.length > 0 && (
                <button type="button" className="link-btn" onClick={() => store.getState().actions.applyBrandFont(role, { kitId: kit.id })}>
                  Apply to selected text
                </button>
              )}
            </div>
          );
        })}
      </div>

      <h3 className="panel__section-title">Logos</h3>
      <div className="media-grid media-grid--logos">
        {kit.logos.map((l) => {
          const a = kit.assets[l.assetId];
          return (
            <div key={l.id} className="logo-tile">
              <button type="button" className="media-tile" onClick={() => store.getState().actions.insertBrandLogo(l.id, kit.id)} aria-label={`Insert logo ${l.name || ''}`.trim()} title="Insert logo">
                {a && <img src={a.src} alt="" draggable={false} />}
              </button>
              <button type="button" className="brand-color__remove" aria-label={`Remove logo ${l.name || ''}`.trim()} onClick={() => edit(removeBrandLogo(kit, l.id))}>
                <Icon name="close" size={10} strokeWidth={2.5} />
              </button>
            </div>
          );
        })}
        <button type="button" className="media-tile media-tile--add" onClick={() => logoInput.current?.click()} aria-label="Upload logo" disabled={busy === 'logo'}>
          {busy === 'logo' ? <Spinner size={18} /> : <Icon name="plus" size={20} />}
        </button>
        <input
          ref={logoInput}
          type="file"
          hidden
          multiple
          accept={IMAGE_ACCEPT}
          aria-label="Choose logo files"
          onChange={(e) => {
            const files = [...(e.target.files ?? [])];
            e.target.value = '';
            if (files.length) void uploadLogos(files);
          }}
        />
      </div>
      <p className="panel__hint">“Apply brand to design” maps the design’s most-used colors to your brand colors in order, and restyles headings, subheadings and body text with your brand fonts.</p>
    </PanelShell>
  );
}

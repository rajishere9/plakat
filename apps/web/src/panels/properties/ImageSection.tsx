/** Image properties: crop mode, fit, flips, corner radius, filters, replace, attribution. */
import { useRef, useState, type JSX } from 'react';
import { DEFAULT_FILTERS, type ImageElement, type ImageFilters, type ObjectFit } from '@plakat/schema';
import { useEd, useServices, useStoreApi } from '../../app/services.tsx';
import { errorMessage, toast } from '../../app/toasts.tsx';
import { Slider } from '../../components/Slider.tsx';
import { Button, IconButton, Section, Segmented, Switch } from '../../components/ui.tsx';
import { IMAGE_ACCEPT } from '../../lib/images.ts';
import { uploadImageFile } from '../uploads.ts';
import { commonValue, patchElements } from './shared.tsx';

type NumericFilter = 'brightness' | 'contrast' | 'saturation' | 'blur';
type ToggleFilter = 'grayscale' | 'sepia' | 'invert';

export const NUMERIC_FILTERS: { key: NumericFilter; label: string; min: number; max: number; center?: number }[] = [
  { key: 'brightness', label: 'Brightness', min: -100, max: 100, center: 0 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, center: 0 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, center: 0 },
  { key: 'blur', label: 'Blur', min: 0, max: 100 },
];

export const TOGGLE_FILTERS: { key: ToggleFilter; label: string }[] = [
  { key: 'grayscale', label: 'Grayscale' },
  { key: 'sepia', label: 'Sepia' },
  { key: 'invert', label: 'Invert' },
];

export function filtersAreDefault(f: ImageFilters): boolean {
  return (Object.keys(DEFAULT_FILTERS) as (keyof ImageFilters)[]).every((k) => f[k] === DEFAULT_FILTERS[k]);
}

export function ImageSection({ elements }: { elements: ImageElement[] }): JSX.Element {
  const services = useServices();
  const store = useStoreApi();
  const actions = () => store.getState().actions;
  const ids = elements.map((e) => e.id);
  const single = elements.length === 1 ? elements[0]! : null;
  const asset = useEd((s) => (single && Object.hasOwn(s.document.assets, single.assetId) ? s.document.assets[single.assetId] : undefined));
  const cropModeId = useEd((s) => s.cropModeId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState(false);

  const fit = commonValue(elements, (e) => e.objectFit);
  const radius = commonValue(elements, (e) => e.cornerRadius);
  const filters = (key: keyof ImageFilters) => commonValue(elements, (e) => e.filters[key]);
  const anyCrop = elements.some((e) => e.crop !== null);
  const allDefault = elements.every((e) => filtersAreDefault(e.filters));

  const setFilter = (partial: Partial<ImageFilters>, key: string) => actions().setFilters(ids, partial, { coalesceKey: `filter:${key}:${ids.join(',')}` });

  const replace = async (file: File) => {
    if (!single) return;
    setReplacing(true);
    try {
      const up = await uploadImageFile(file, services.api);
      actions().replaceImage(single.id, up);
    } catch (e) {
      toast.error('Could not replace the image', { detail: errorMessage(e) });
    } finally {
      setReplacing(false);
    }
  };

  const src = asset?.source;
  return (
    <>
      <Section title="Image">
        {single && (
          <div className="btn-row">
            {cropModeId === single.id ? (
              <Button size="sm" variant="primary" icon="check" onClick={() => actions().exitCropMode()}>
                Done cropping
              </Button>
            ) : (
              <Button size="sm" icon="crop" onClick={() => actions().enterCropMode(single.id)}>
                Crop
              </Button>
            )}
            <Button size="sm" icon="replace" busy={replacing} onClick={() => fileRef.current?.click()}>
              Replace
            </Button>
            <input
              ref={fileRef}
              type="file"
              hidden
              accept={IMAGE_ACCEPT}
              aria-label="Choose a replacement image"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void replace(f);
              }}
            />
          </div>
        )}
        <Segmented<ObjectFit>
          label="Image fit"
          size="sm"
          value={anyCrop ? null : fit}
          options={[
            { value: 'cover', label: 'Fill' },
            { value: 'contain', label: 'Fit' },
            { value: 'fill', label: 'Stretch' },
          ]}
          onChange={(v) => actions().updateElements(ids, { objectFit: v, crop: null }, { label: 'Image fit' })}
        />
        {anyCrop && (
          <button type="button" className="link-btn" onClick={() => ids.forEach((id) => actions().setCrop(id, null))}>
            Reset crop
          </button>
        )}
        <div className="btn-row">
          <IconButton label="Flip horizontally" icon="flipH" pressed={elements.every((e) => e.flipX)} onClick={() => actions().flip(ids, 'x')} />
          <IconButton label="Flip vertically" icon="flipV" pressed={elements.every((e) => e.flipY)} onClick={() => actions().flip(ids, 'y')} />
        </div>
        <Slider
          label="Corner radius"
          value={radius ?? 0}
          min={0}
          max={Math.max(1, Math.round(Math.min(...elements.map((e) => Math.min(e.width, e.height))) / 2))}
          onChange={(v) => patchElements(actions(), ids, 'cornerRadius', { cornerRadius: v }, 'Corner radius')}
          onCommit={() => actions().breakCoalescing()}
        />
      </Section>
      <Section
        title="Adjust"
        actions={
          <Button size="sm" variant="ghost" icon="reset" disabled={allDefault} onClick={() => actions().resetFilters(ids)}>
            Reset
          </Button>
        }
      >
        {NUMERIC_FILTERS.map((f) => (
          <Slider
            key={f.key}
            label={f.label}
            value={(filters(f.key) as number | null) ?? 0}
            min={f.min}
            max={f.max}
            center={f.center}
            onChange={(v) => setFilter({ [f.key]: Math.round(v) }, f.key)}
            onCommit={() => actions().breakCoalescing()}
          />
        ))}
        <div className="switch-list">
          {TOGGLE_FILTERS.map((f) => (
            <Switch key={f.key} label={f.label} checked={filters(f.key) === true} onChange={(v) => setFilter({ [f.key]: v }, f.key)} />
          ))}
        </div>
      </Section>
      {single && src && (src.attribution || src.author || src.license) && (
        <Section title="Credit">
          <p className="attribution">
            {src.attribution ?? [src.author, src.license].filter(Boolean).join(' · ')}
            {src.pageUrl && (
              <>
                {' '}
                <a href={src.pageUrl} target="_blank" rel="noreferrer">
                  Source
                </a>
              </>
            )}
            {src.licenseUrl && (
              <>
                {' · '}
                <a href={src.licenseUrl} target="_blank" rel="noreferrer">
                  License
                </a>
              </>
            )}
          </p>
        </Section>
      )}
    </>
  );
}

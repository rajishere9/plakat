import type { PageSize, PhysicalSize } from './types.ts';
import { physicalToPx } from './units.ts';

export type PresetCategory = 'social' | 'video' | 'print';

export interface PagePreset {
  id: string;
  label: string;
  category: PresetCategory;
  /** Document px (exact; fractional for some physical sizes). */
  width: number;
  height: number;
  physical: PhysicalSize | null;
}

function screen(id: string, label: string, category: PresetCategory, width: number, height: number): PagePreset {
  return { id, label, category, width, height, physical: null };
}

function physical(id: string, label: string, phys: PhysicalSize): PagePreset {
  const px = physicalToPx(phys);
  return { id, label, category: 'print', width: px.width, height: px.height, physical: phys };
}

export const PAGE_PRESETS = [
  screen('instagram-post', 'Instagram post', 'social', 1080, 1080),
  screen('instagram-story', 'Instagram story', 'social', 1080, 1920),
  screen('youtube-thumbnail', 'YouTube thumbnail', 'video', 1280, 720),
  physical('a4-poster', 'A4 poster', { width: 210, height: 297, unit: 'mm' }),
  physical('business-card', 'Business card (US, 3.5 × 2 in)', { width: 3.5, height: 2, unit: 'in' }),
  physical('business-card-eu', 'Business card (EU, 85 × 55 mm)', { width: 85, height: 55, unit: 'mm' }),
] as const satisfies readonly PagePreset[];

export type PresetId = (typeof PAGE_PRESETS)[number]['id'];

export const DEFAULT_PRESET_ID: PresetId = 'instagram-post';

export function getPreset(id: string): PagePreset | undefined {
  return PAGE_PRESETS.find((p) => p.id === id);
}

export function isPresetId(id: string): id is PresetId {
  return getPreset(id) !== undefined;
}

export function presetToPageSize(preset: PagePreset | PresetId): PageSize {
  const p = typeof preset === 'string' ? getPreset(preset) : preset;
  if (!p) throw new Error(`Unknown page preset: ${String(preset)}`);
  return {
    width: p.width,
    height: p.height,
    presetId: p.id,
    physical: p.physical ? { ...p.physical } : null,
  };
}

/** A custom page size given in px (screen) or physical units (print). */
export function customPageSize(
  width: number,
  height: number,
  unit: 'px' | PhysicalSize['unit'] = 'px',
): PageSize {
  if (unit === 'px') return { width, height, presetId: null, physical: null };
  const phys: PhysicalSize = { width, height, unit };
  const px = physicalToPx(phys);
  return { width: px.width, height: px.height, presetId: null, physical: phys };
}

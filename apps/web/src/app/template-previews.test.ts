import { createDocument } from '@plakat/schema';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TemplateSummary } from '../api/index.ts';
import { clearTemplatePreviewCache, templatePreviewUrl } from './template-previews.ts';

function summary(id: string, builtIn: boolean): TemplateSummary {
  return { id, title: id, category: null, size: { width: 100, height: 100 }, pageCount: 1, slotCount: 0, thumbnailUrl: null, builtIn } as TemplateSummary;
}

function services() {
  const document = createDocument({ width: 100, height: 100, presetId: null, physical: null }, { kind: 'template' });
  return {
    api: {
      getTemplate: vi.fn(async () => ({ id: document.id, document, builtIn: false, version: 1, updatedAt: '' })),
      uploadTemplateThumbnail: vi.fn(async () => ({ thumbnailUrl: '/t.png' })),
    },
    renderPreview: vi.fn(async () => new Blob([new Uint8Array([0x89])], { type: 'image/png' })),
  };
}

afterEach(() => clearTemplatePreviewCache());

describe('templatePreviewUrl', () => {
  it('uploads the rendered preview as a user template thumbnail', async () => {
    const s = services();
    await templatePreviewUrl(summary('doc_user1', false), s as never);
    expect(s.api.uploadTemplateThumbnail).toHaveBeenCalledWith('doc_user1', expect.any(Blob));
  });

  it('never uploads thumbnails for built-in templates (server answers 403)', async () => {
    const s = services();
    await templatePreviewUrl(summary('tpl_builtin', true), s as never);
    expect(s.renderPreview).toHaveBeenCalled();
    expect(s.api.uploadTemplateThumbnail).not.toHaveBeenCalled();
  });
});

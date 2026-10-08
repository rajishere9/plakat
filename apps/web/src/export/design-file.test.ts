import { describe, expect, it } from 'vitest';
import { parseDocument, type Asset, type AssetFetcher } from '@plakat/schema';
import { makeStore } from '../store/test-helpers.ts';
import { buildPortableFile, portableFileName } from './design-file.ts';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const fetcher: AssetFetcher = async () => ({ bytes: PNG });
const asset = (src: string): Asset => ({ type: 'image', mimeType: 'image/png', width: 10, height: 10, src, name: src, source: null });

describe('design file (.plakat.json)', () => {
  it('embeds assets, round-trips through parseDocument and drops assets no page uses', async () => {
    const { store } = makeStore();
    const a = store.getState().actions;
    const id = a.addImage(asset('/uploads/old.png'));
    a.replaceImage(id, asset('/uploads/new.png'));
    const doc = store.getState().document;
    expect(Object.keys(doc.assets)).toHaveLength(2); // the old record stays for undo
    const { text, filename } = await buildPortableFile({ ...doc, meta: { ...doc.meta, title: 'My poster' } }, fetcher);
    expect(filename).toBe(portableFileName({ meta: { ...doc.meta, title: 'My poster' } }));
    const back = parseDocument(text);
    const assets = Object.values(back.assets);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.name).toBe('/uploads/new.png');
    expect(assets[0]!.src.startsWith('data:image/png;base64,')).toBe(true);
    expect(back.pages).toEqual(doc.pages.map((p) => ({ ...p, elements: p.elements.map((e) => ({ ...e })) })));
  });

  it('a remote orphan that cannot be fetched does not break the download', async () => {
    const { store } = makeStore();
    const a = store.getState().actions;
    a.addAsset(asset('https://gone.example/x.png'));
    a.addImage(asset('/uploads/ok.png'));
    const failing: AssetFetcher = async (src) => {
      if (src.startsWith('https://gone')) throw new Error('404');
      return { bytes: PNG };
    };
    const { text } = await buildPortableFile(store.getState().document, failing);
    expect(Object.values(parseDocument(text).assets).map((x) => x.name)).toEqual(['/uploads/ok.png']);
  });
});

## New template: <!-- title, e.g. "Wedding invitation" -->

**Category / file:** `templates/<category>/<slug>.plakat.json`
**Made with:** <!-- the editor (path A) or the generator (path B) -->
**Preset:** <!-- e.g. Instagram post 1080 × 1080 -->

### Preview

<!-- Attach the PNGs from `npx tsx templates/scripts/preview-templates.ts --stress <slug>`:
     the normal render AND the --stress render (max-length text in every slot). -->

### Image sources

<!-- For every image: where it comes from, author, license (own work or CC0 only). -->

| Asset | Source | Author | License |
|---|---|---|---|
|  |  |  |  |

### Checklist ([docs/templates.md](../../docs/templates.md#pr-checklist))

- [ ] File at `templates/<category>/<slug>.plakat.json`, kebab-case, with a stable, unique document `id`
- [ ] `template.category` equals the directory name; an existing category is reused unless the format is new
- [ ] Title (short, Title case), one-sentence description and lowercase tags
- [ ] Slots for every text a user would always change, every photo/logo and the 1–2 defining colors
- [ ] Slot labels short and in sentence case, ordered by importance, colors last
- [ ] `maxLength` on every text slot, chosen with the `--stress` preview; `multiline` set correctly
- [ ] `required` only on the essential fields; color slots have a 3–5 swatch palette
- [ ] Only fonts and weights from `GOOGLE_FONTS_CATALOG`; at most 2 families plus an optional accent
- [ ] Images embedded as `data:` URIs, ≤ ~60 KB each, file < 1.5 MB
- [ ] Every image is my own work or CC0, with `asset.source` (license and author) filled in
- [ ] No real people, brands, logos or trademarks in placeholder content
- [ ] Important content inside the safe margins (story top/bottom ~250 px, YouTube bottom-right corner, ~3 mm on print)
- [ ] `npx vitest run templates/` passes
- [ ] Generator templates: `npm run templates:check` passes

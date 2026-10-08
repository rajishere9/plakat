<!--
Thanks for contributing! Adding a template? Use the template checklist instead:
open the PR with `?template=new_template.md` appended to the compare URL,
or copy the checklist from .github/PULL_REQUEST_TEMPLATE/new_template.md.
-->

## What and why

<!-- What does this change, and what problem does it solve? Link the issue: "Fixes #123". -->

## How I tested it

<!-- Commands you ran, browsers you tried, screenshots or a short recording for UI changes. -->

## Checklist

- [ ] `npm run typecheck` and `npm test` pass
- [ ] `npm run test:e2e` passes (needed when the editor, renderer or server API changed)
- [ ] New behavior has tests beside the code; a bug fix has a test that fails without it
- [ ] Parity rule respected: document content is only drawn by `PageScene` from `@plakat/renderer`, and no export uses `stage.toCanvas()` on the editor stage
- [ ] Persisted format changed? `schemaVersion` bumped, migration + fixture + tests added, `docs/document-schema.md` updated
- [ ] Docs updated (`README.md`, `docs/`, `.env.example`) for user-visible or configuration changes
- [ ] No new runtime dependency (or it was agreed in an issue first)

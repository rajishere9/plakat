/**
 * Editor screen: loads the project/template for the route, wires persistence, keyboard
 * shortcuts and the system clipboard, and lays out top bar, left rail + flyout panel,
 * the canvas Workspace and the properties panel.
 */
import { useCallback, useEffect, useState, type JSX } from 'react';
import { Workspace } from '../canvas/Workspace';
import { isDialogOpen } from '../components/Dialog.tsx';
import { Button, EmptyState, Spinner } from '../components/ui.tsx';
import { downloadDocumentFile } from '../export/design-file.ts';
import { ExportDialog } from '../export/ExportDialog.tsx';
import { BrandPanel } from '../panels/BrandPanel.tsx';
import { ElementsPanel } from '../panels/ElementsPanel.tsx';
import { LayersPanel } from '../panels/LayersPanel.tsx';
import { PagesPanel } from '../panels/PagesPanel.tsx';
import { PhotosPanel } from '../panels/PhotosPanel.tsx';
import { PropertiesPanel } from '../panels/properties/PropertiesPanel.tsx';
import { TemplatesPanel } from '../panels/TemplatesPanel.tsx';
import { TextPanel } from '../panels/TextPanel.tsx';
import { UploadsPanel } from '../panels/UploadsPanel.tsx';
import { loadBrandKits } from '../panels/brand-sync.ts';
import { imageFilesOf, uploadImageFile } from '../panels/uploads.ts';
import type { WorkspaceDropTarget } from '../canvas/Workspace';
import type { WorkspaceStatus } from '../canvas/controller.ts';
import { ApiError } from '../api/index.ts';
import { templateCategories, useAsync } from './hooks.ts';
import { FLYOUT_ID, LeftRail } from './LeftRail.tsx';
import { navigate } from './router.ts';
import { SaveAsTemplateDialog } from './SaveAsTemplateDialog.tsx';
import { useEd, useServices, type AppServices } from './services.tsx';
import { ShortcutsDialog } from './ShortcutsDialog.tsx';
import { useUseTemplate } from './UseTemplateDialog.tsx';
import { dismissToast, errorMessage, toast } from './toasts.tsx';
import { TopBar } from './TopBar.tsx';

export interface EditorProps {
  kind: 'design' | 'template';
  id: string;
}

/** Uploads image files and inserts each as an image element on the active page. */
export async function uploadAndInsert(files: File[], services: Pick<AppServices, 'api' | 'store'>, target: WorkspaceDropTarget | null = null): Promise<void> {
  files = imageFilesOf(files);
  if (!files.length) return;
  toast.info(files.length === 1 ? `Uploading ${files[0]!.name}…` : `Uploading ${files.length} images…`, { duration: 0, key: 'paste-upload' });
  let added = 0;
  await Promise.all(
    files.map(async (f) => {
      try {
        const asset = await uploadImageFile(f, services.api);
        const actions = services.store.getState().actions;
        const id = actions.addImage(asset, {}, target ? { pageId: target.pageId } : {});
        if (!id) throw new Error('The image could not be added to the page.');
        added++;
        if (target && files.length === 1) {
          // Center the new image on the drop point (merged into the "Add image" undo step).
          const el = services.store.getState().document.pages.find((p) => p.id === target.pageId)?.elements.find((e) => e.id === id);
          if (el) actions.updateElement(id, { x: target.x - el.width / 2, y: target.y - el.height / 2 }, { merge: true });
        }
      } catch (e) {
        toast.error(files.length === 1 ? 'Upload failed' : `Upload of ${f.name} failed`, { detail: errorMessage(e) });
      }
    }),
  );
  if (added > 0) toast.success(added === 1 ? 'Image added' : `${added} images added`, { key: 'paste-upload' });
  else dismissToast('paste-upload');
}

function FlyoutPanel({ panel, onClose }: { panel: string; onClose: () => void }): JSX.Element | null {
  switch (panel) {
    case 'templates':
      return <TemplatesPanel onClose={onClose} />;
    case 'shapes':
      return <ElementsPanel onClose={onClose} />;
    case 'text':
      return <TextPanel onClose={onClose} />;
    case 'uploads':
      return <UploadsPanel onClose={onClose} />;
    case 'photos':
      return <PhotosPanel onClose={onClose} />;
    case 'brand':
      return <BrandPanel onClose={onClose} />;
    case 'layers':
      return <LayersPanel onClose={onClose} />;
    case 'pages':
      return <PagesPanel onClose={onClose} />;
    default:
      return null;
  }
}

const RAIL_PANELS = new Set(['templates', 'shapes', 'text', 'uploads', 'photos', 'brand', 'layers', 'pages']);

export function Editor({ kind, id }: EditorProps): JSX.Element {
  const services = useServices();
  const { store, persistence } = services;
  const [load, setLoad] = useState<{ state: 'loading' | 'ready' | 'error'; error?: unknown }>(() => {
    const s = store.getState();
    return s.projectId === id && s.projectKind === (kind === 'design' ? 'project' : 'template') ? { state: 'ready' } : { state: 'loading' };
  });
  const [attempt, setAttempt] = useState(0);
  const [exportOpen, setExportOpen] = useState(false);
  const [tplOpen, setTplOpen] = useState(false);
  const activePanel = useEd((s) => s.activePanel);
  const shortcutsOpen = useEd((s) => s.shortcutsHelpOpen);
  const lastError = useEd((s) => s.lastError);
  const saveStatus = useEd((s) => s.saveStatus);
  const doc = useEd((s) => s.document);
  const templates = useAsync(() => (tplOpen ? services.api.listTemplates({}) : Promise.resolve([])), [tplOpen, services.api]);

  // --- load the document for the route -----------------------------------------------
  useEffect(() => {
    const s = store.getState();
    const projectKind = kind === 'design' ? 'project' : 'template';
    if (s.projectId === id && s.projectKind === projectKind && attempt === 0) {
      setLoad({ state: 'ready' });
      return;
    }
    let cancelled = false;
    setLoad({ state: 'loading' });
    const p = kind === 'design' ? persistence.loadProject(id) : persistence.openTemplate(id);
    p.then(
      () => !cancelled && setLoad({ state: 'ready' }),
      (error: unknown) => !cancelled && setLoad({ state: 'error', error }),
    );
    return () => {
      cancelled = true;
    };
  }, [kind, id, attempt, persistence, store]);

  useEffect(() => {
    document.title = doc.meta.title ? `${doc.meta.title} – Plakat` : 'Plakat';
  }, [doc.meta.title]);

  // --- brand kits (once per editor mount) --------------------------------------------------
  useEffect(() => {
    loadBrandKits(services.api, store).catch((e) => console.warn('[plakat] brand kits unavailable', e));
  }, [services.api, store]);

  // --- user-facing action errors from the store --------------------------------------------
  useEffect(() => {
    if (!lastError) return;
    toast.error(lastError, { key: 'store-error' });
    store.getState().actions.setError(null);
  }, [lastError, store]);

  useEffect(() => {
    if (saveStatus === 'conflict') toast.warning('This design was changed in another tab or by someone else.', { key: 'conflict', detail: 'Use the status menu next to the title to choose which version to keep.', duration: 0 });
  }, [saveStatus]);

  const openExport = useCallback(() => setExportOpen(true), []);

  // Flush pending saves when leaving the editor.
  useEffect(() => () => void persistence.flush(), [persistence]);

  const goHome = async () => {
    try {
      await persistence.flush();
      // Refresh the gallery thumbnail before leaving (bounded wait, best effort).
      await Promise.race([persistence.uploadThumbnailNow(), new Promise((r) => setTimeout(r, 2500))]);
    } catch {
      /* saving errors are surfaced by the save status */
    } finally {
      navigate({ name: 'home' });
    }
  };

  const downloadFile = async () => {
    const key = 'design-file';
    toast.info('Preparing file…', { key, duration: 0 });
    try {
      const name = await downloadDocumentFile(store.getState().document);
      toast.success(`Downloaded ${name}`, { key });
    } catch (e) {
      toast.error('Could not create the file', { key, detail: errorMessage(e) });
    }
  };

  const useTpl = useUseTemplate();
  const useTemplate = () => useTpl.start({ template: store.getState().document });

  const onWorkspaceStatus = useCallback((st: WorkspaceStatus) => {
    if (st.loading) return;
    if (st.missingFonts.length) {
      toast.warning('Some fonts could not be loaded', { key: 'missing-fonts', detail: `${st.missingFonts.join(', ')} — shown with a fallback font. Exports will ask before using fallbacks.` });
    } else {
      // A late font arrived (the canvas was rebuilt with it): the warning no longer applies.
      dismissToast('missing-fonts');
    }
    if (st.missingAssets.length) {
      toast.warning(`${st.missingAssets.length === 1 ? 'An image' : `${st.missingAssets.length} images`} could not be loaded`, { key: 'missing-assets', detail: 'Missing images are shown as a checkerboard. Replace them before exporting.' });
    }
  }, []);

  if (load.state === 'loading') {
    return (
      <div className="screen-center">
        <Spinner size={28} label="Opening design" />
      </div>
    );
  }
  if (load.state === 'error') {
    const notFound = load.error instanceof ApiError && load.error.isNotFound;
    return (
      <div className="screen-center">
        <EmptyState
          tone="error"
          title={notFound ? `This ${kind} does not exist` : `The ${kind} could not be opened`}
          action={
            <div className="btn-row">
              {!notFound && <Button onClick={() => setAttempt((a) => a + 1)}>Try again</Button>}
              <Button variant="primary" onClick={() => navigate({ name: 'home' })}>
                Go to home
              </Button>
            </div>
          }
        >
          {errorMessage(load.error)}
        </EmptyState>
      </div>
    );
  }

  const panel = activePanel && RAIL_PANELS.has(activePanel) ? activePanel : null;
  const readonly = saveStatus === 'readonly';

  return (
    <div className="editor">
      <TopBar
        onHome={() => void goHome()}
        onExport={openExport}
        onSaveAsTemplate={() => setTplOpen(true)}
        onDownloadFile={() => void downloadFile()}
        onShortcuts={() => store.getState().actions.setShortcutsHelpOpen(true)}
        onUseTemplate={readonly && doc.kind === 'template' ? () => void useTemplate() : undefined}
      />
      {readonly && (
        <div className="banner" role="status">
          This is a built-in template, so changes are not saved. Use it to start your own design, or “Save as template” to make an editable copy.
        </div>
      )}
      <div className="editor__main">
        <LeftRail />
        {panel && (
          <div className="flyout" id={FLYOUT_ID}>
            <FlyoutPanel panel={panel} onClose={() => store.getState().actions.setActivePanel(null)} />
          </div>
        )}
        <main className="editor__canvas" aria-label="Canvas">
          <Workspace
            store={store}
            env={services.getRenderEnv()}
            onSave={() => void persistence.saveNow()}
            onExport={openExport}
            nativeClipboard
            onPasteFiles={(files) => void uploadAndInsert(files, services)}
            onDropFiles={(files, target) => void uploadAndInsert(files, services, target)}
            shortcutFilter={(match) => !isDialogOpen() || match.id === 'save'}
            onStatus={onWorkspaceStatus}
          />
        </main>
        <PropertiesPanel />
      </div>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} />
      <SaveAsTemplateDialog open={tplOpen} onClose={() => setTplOpen(false)} document={doc} categories={templateCategories(templates.data ?? [])} />
      {useTpl.element}
      <ShortcutsDialog open={shortcutsOpen} onClose={() => store.getState().actions.setShortcutsHelpOpen(false)} />
    </div>
  );
}

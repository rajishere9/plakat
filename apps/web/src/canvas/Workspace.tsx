/**
 * <Workspace>: the editor canvas. Fills its container and renders the editor stage with
 * plain Konva through WorkspaceController (content = the renderer's PageScenes, chrome =
 * Transformer/guides/outlines), plus the DOM overlays (inline text editor, context menu).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import type { RenderEnv } from '@plakat/renderer';
import type { Id } from '@plakat/schema';
import { isEditableTarget, type ShortcutMatch } from '../lib/shortcuts.ts';
import { editorStore, type EditorStore } from '../store/editor-store.ts';
import { createClipboardEventHandlers, createShortcutHandler } from '../store/shortcut-handler.ts';
import { buildContextMenuItems, WorkspaceContextMenu, type ContextMenuState } from './ContextMenu.tsx';
import { WorkspaceController, type ContextMenuRequest, type WorkspaceStatus } from './controller.ts';
import { getRenderEnv } from './render-env.ts';
import { installTestHook } from './test-hook.ts';
import { TextEditorOverlay } from './TextEditor.tsx';

export interface WorkspaceDropTarget {
  pageId: Id;
  /** Page px of the drop point. */
  x: number;
  y: number;
}

export interface WorkspaceProps {
  /** Store to render (default: the app-wide editorStore). */
  store?: EditorStore;
  /** Render environment (default: the shared browser env from getRenderEnv()). */
  env?: RenderEnv;
  className?: string;
  style?: CSSProperties;
  /** Bind the keyboard shortcuts (lib/shortcuts) on window keydown. Default true. */
  shortcuts?: boolean;
  /** Veto individual shortcuts (e.g. while a modal is open): return false to ignore. */
  shortcutFilter?: (match: ShortcutMatch, event: KeyboardEvent) => boolean;
  /** Mod+S. */
  onSave?: () => void;
  /** Mod+E. */
  onExport?: () => void;
  /** Sync copy/cut/paste with the system clipboard (document listeners). Default false. */
  nativeClipboard?: boolean;
  /** Image files pasted from the OS (with nativeClipboard). */
  onPasteFiles?: (files: File[]) => void;
  /** Files dropped on the workspace; `target` is the page point under the drop (null outside pages). */
  onDropFiles?: (files: File[], target: WorkspaceDropTarget | null) => void;
  /** Right-click menu. Default true. */
  contextMenu?: boolean;
  /** Expose window.__plakat (e2e hook). Default true. */
  testHook?: boolean;
  /** Called once the controller exists (and with null on unmount). */
  onController?: (controller: WorkspaceController | null) => void;
  /** Loading / missing fonts / missing assets. */
  onStatus?: (status: WorkspaceStatus) => void;
}

const rootStyle: CSSProperties = {
  position: 'relative',
  width: '100%',
  height: '100%',
  minWidth: 0,
  minHeight: 0,
  overflow: 'hidden',
  background: 'var(--plakat-workspace-bg, #e8e9ee)',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  touchAction: 'none',
  outline: 'none',
};

const hostStyle: CSSProperties = { position: 'absolute', inset: 0, overflow: 'hidden' };

export function Workspace(props: WorkspaceProps) {
  const store = props.store ?? editorStore;
  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [controller, setController] = useState<WorkspaceController | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [status, setStatus] = useState<WorkspaceStatus | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const env = props.env;
  const contextMenuEnabled = props.contextMenu !== false;
  const testHook = props.testHook !== false;

  // --- controller lifecycle ------------------------------------------------------------
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const c = new WorkspaceController({
      host,
      store,
      env: env ?? getRenderEnv(),
      onStatus: (s) => {
        setStatus(s);
        propsRef.current.onStatus?.(s);
      },
      onContextMenu: (req: ContextMenuRequest) => {
        if (propsRef.current.contextMenu === false) return;
        const root = rootRef.current;
        const w = root?.clientWidth ?? Infinity;
        const h = root?.clientHeight ?? Infinity;
        const rows = buildContextMenuItems(store).length;
        setMenu({ x: Math.max(4, Math.min(req.x, w - 216)), y: Math.max(4, Math.min(req.y, h - rows * 31 - 16)) });
      },
    });
    setController(c);
    propsRef.current.onController?.(c);
    const uninstall = testHook ? installTestHook(c, store) : () => {};
    return () => {
      uninstall();
      propsRef.current.onController?.(null);
      c.destroy();
      setController(null);
    };
  }, [store, env, testHook]);

  // --- keyboard: shortcuts, Space (pan), Shift (rotation snap), Enter ----------------------
  useEffect(() => {
    if (!controller) return;
    const shortcuts =
      props.shortcuts === false
        ? null
        : createShortcutHandler({
            store,
            onSave: () => propsRef.current.onSave?.(),
            onExport: () => propsRef.current.onExport?.(),
            nativeClipboard: !!props.nativeClipboard,
            filter: (m, e) => (propsRef.current.shortcutFilter ? propsRef.current.shortcutFilter(m, e) : true),
            overrides: {
              // Escape while cropping discards the crop edit (Enter / click outside applies it).
              escape: () => controller.cancelCrop(),
            },
          });
    // Space/Enter only act when focus is not on some other control (button, menu, input).
    const focusIsFree = (t: EventTarget | null) =>
      !t || t === document.body || t === document.documentElement || (t instanceof Node && !!rootRef.current?.contains(t));
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Shift') controller.setShiftKey(true);
      if (e.defaultPrevented) return;
      const free = !isEditableTarget(e.target) && focusIsFree(e.target);
      if (free && e.code === 'Space' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        controller.setSpaceKey(true);
        e.preventDefault();
        return;
      }
      if (free && e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.repeat && controller.handleEnter()) {
        e.preventDefault();
        return;
      }
      shortcuts?.(e);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') controller.setShiftKey(false);
      if (e.code === 'Space') controller.setSpaceKey(false);
    };
    const onBlur = () => {
      controller.setShiftKey(false);
      controller.setSpaceKey(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    let removeClipboard = () => {};
    if (props.shortcuts !== false && props.nativeClipboard) {
      const h = createClipboardEventHandlers({ store, onPasteFiles: (files) => propsRef.current.onPasteFiles?.(files) });
      document.addEventListener('copy', h.onCopy);
      document.addEventListener('cut', h.onCut);
      document.addEventListener('paste', h.onPaste);
      removeClipboard = () => {
        document.removeEventListener('copy', h.onCopy);
        document.removeEventListener('cut', h.onCut);
        document.removeEventListener('paste', h.onPaste);
      };
    }
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
      removeClipboard();
    };
  }, [controller, store, props.shortcuts, props.nativeClipboard]);

  // --- file drop ------------------------------------------------------------------------------
  const onDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!propsRef.current.onDropFiles) return;
    if (Array.from(e.dataTransfer.types).includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  }, []);
  const onDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      const cb = propsRef.current.onDropFiles;
      if (!cb) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      e.preventDefault();
      const rect = hostRef.current?.getBoundingClientRect();
      const target = controller && rect ? controller.screenToPagePoint({ x: e.clientX - rect.left, y: e.clientY - rect.top }) : null;
      cb(files, target);
    },
    [controller],
  );

  const closeMenu = useCallback(() => setMenu(null), []);

  return (
    <div
      ref={rootRef}
      className={props.className}
      style={{ ...rootStyle, ...props.style }}
      data-plakat-workspace=""
      data-loading={status?.loading ? '' : undefined}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div ref={hostRef} style={hostStyle} data-plakat-stage="" />
      {controller && <TextEditorOverlay controller={controller} store={store} />}
      {controller && contextMenuEnabled && menu && <WorkspaceContextMenu state={menu} store={store} onClose={closeMenu} />}
    </div>
  );
}

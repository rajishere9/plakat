/**
 * Tiny hash router (no dependency):
 *   #/                 home
 *   #/design/:id       editor for a project (design)
 *   #/template/:id     editor for a template (built-ins open read-only)
 */
import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'design'; id: string }
  | { name: 'template'; id: string }
  | { name: 'notFound'; path: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').replace(/^\/?/, '/').replace(/\/+$/, '') || '/';
  if (path === '/' || path === '') return { name: 'home' };
  const m = /^\/(design|template)\/([^/?#]+)$/.exec(path);
  if (m) {
    let id: string;
    try {
      id = decodeURIComponent(m[2]!);
    } catch {
      return { name: 'notFound', path };
    }
    return m[1] === 'design' ? { name: 'design', id } : { name: 'template', id };
  }
  return { name: 'notFound', path };
}

export function routeToHash(route: Route): string {
  switch (route.name) {
    case 'home':
      return '#/';
    case 'design':
      return `#/design/${encodeURIComponent(route.id)}`;
    case 'template':
      return `#/template/${encodeURIComponent(route.id)}`;
    case 'notFound':
      return `#${route.path}`;
  }
}

/** Navigates (pushes a history entry). `replace` swaps the current entry instead. */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const hash = routeToHash(route);
  if (options.replace) {
    const url = `${location.pathname}${location.search}${hash}`;
    history.replaceState(history.state, '', url);
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else if (location.hash !== hash) {
    location.hash = hash;
  }
}

const subscribe = (cb: () => void) => {
  window.addEventListener('hashchange', cb);
  window.addEventListener('popstate', cb);
  return () => {
    window.removeEventListener('hashchange', cb);
    window.removeEventListener('popstate', cb);
  };
};
const getHash = () => location.hash;

/** Current route; re-renders on hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, getHash, () => '');
  return parseRoute(hash);
}

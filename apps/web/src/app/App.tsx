/** Root component: services provider, hash routing, toasts, persistence lifecycle. */
import { useEffect, type JSX } from 'react';
import { Button, EmptyState } from '../components/ui.tsx';
import { Editor } from './Editor.tsx';
import { Home } from './Home.tsx';
import { navigate, useRoute } from './router.ts';
import { getDefaultServices, ServicesProvider, type AppServices } from './services.tsx';
import { Toaster } from './toasts.tsx';

export function App({ services = getDefaultServices() }: { services?: AppServices }): JSX.Element {
  const route = useRoute();

  useEffect(() => {
    const stop = services.persistence.start();
    const removeUnload = services.persistence.installBeforeUnload();
    return () => {
      stop();
      removeUnload();
    };
  }, [services]);

  useEffect(() => {
    const title = route.name === 'home' ? 'Plakat' : null;
    if (title) document.title = title;
  }, [route.name]);

  let screen: JSX.Element;
  switch (route.name) {
    case 'home':
      screen = <Home />;
      break;
    case 'design':
    case 'template':
      screen = <Editor key={`${route.name}:${route.id}`} kind={route.name} id={route.id} />;
      break;
    default:
      screen = (
        <div className="screen-center">
          <EmptyState
            icon="info"
            title="Page not found"
            action={
              <Button variant="primary" onClick={() => navigate({ name: 'home' })}>
                Go to home
              </Button>
            }
          >
            There is nothing at this address.
          </EmptyState>
        </div>
      );
  }

  return (
    <ServicesProvider value={services}>
      {screen}
      <Toaster />
    </ServicesProvider>
  );
}

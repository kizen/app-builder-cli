import { lazy } from 'react';
import { createRoute, createRootRoute, createRouter } from '@tanstack/react-router';
import { App } from './App.js';
import { SummaryPage } from './pages/SummaryPage.js';

const AppDetailPage = lazy(() =>
  import('./pages/AppDetailPage.js').then((m) => ({ default: m.AppDetailPage })),
);
const SandboxPage = lazy(() =>
  import('./pages/SandboxPage.js').then((m) => ({ default: m.SandboxPage })),
);
const ConfigurationPage = lazy(() =>
  import('./pages/ConfigurationPage.js').then((m) => ({ default: m.ConfigurationPage })),
);
const VersionsPage = lazy(() =>
  import('./pages/VersionsPage.js').then((m) => ({ default: m.VersionsPage })),
);
const IconReferencePage = lazy(() =>
  import('./pages/IconReferencePage.js').then((m) => ({ default: m.IconReferencePage })),
);
const CodeStepsPage = lazy(() =>
  import('./pages/CodeStepsPage.js').then((m) => ({ default: m.CodeStepsPage })),
);
const SourceBrowserPage = lazy(() =>
  import('./pages/SourceBrowserPage.js').then((m) => ({ default: m.SourceBrowserPage })),
);
const SecretsPage = lazy(() =>
  import('./pages/SecretsPage.js').then((m) => ({ default: m.SecretsPage })),
);

const rootRoute = createRootRoute({ component: App });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: SummaryPage,
});

export const appDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/summary',
  component: AppDetailPage,
});

export const appSandboxRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/sandbox',
  component: SandboxPage,
});

export const appConfigurationRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/configuration',
  component: ConfigurationPage,
});

export const appVersionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/versions',
  component: VersionsPage,
});

export const appIconReferenceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/icons',
  component: IconReferencePage,
});

export const appCodeStepsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/code-steps',
  component: CodeStepsPage,
});

export const appCodeStepDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/code-steps/$stepApiName',
  component: CodeStepsPage,
});

export const appSourceBrowserRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/source',
  component: SourceBrowserPage,
});

export const appSecretsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/$apiName/secrets',
  component: SecretsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  appDetailRoute,
  appSandboxRoute,
  appConfigurationRoute,
  appVersionsRoute,
  appIconReferenceRoute,
  appCodeStepsRoute,
  appCodeStepDetailRoute,
  appSourceBrowserRoute,
  appSecretsRoute,
]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

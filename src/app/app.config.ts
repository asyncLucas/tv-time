import {
  ApplicationConfig,
  isDevMode,
  provideBrowserGlobalErrorListeners,
  provideZoneChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
} from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    // withComponentInputBinding lets route params bind straight to component
    // inputs (e.g. `uuid` on ShowDetail) instead of injecting ActivatedRoute.
    // withInMemoryScrolling resets the scroll to the top on every navigation
    // (the page scrolls the window, not an inner container) so switching menu
    // pages never lands you mid-scroll; anchorScrolling keeps `#fragment` links.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top', anchorScrolling: 'enabled' }),
    ),
    // The service worker is production-only, so the PWA install/update flows
    // are inert under `ng serve` by design.
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};

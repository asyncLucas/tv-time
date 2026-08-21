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
    //
    // withInMemoryScrolling drives the window scroll (the page scrolls the
    // window, not an inner container). 'enabled' means: going *back* returns to
    // where that page was left — so a show opened from deep in the Shows grid
    // lands back on the same row — while every forward/menu navigation still
    // starts at the top, which is what 'top' used to do for all of them.
    // anchorScrolling keeps `#fragment` links working.
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'enabled', anchorScrolling: 'enabled' }),
    ),
    // The service worker is production-only, so the PWA install/update flows
    // are inert under `ng serve` by design.
    //
    // sw.js is public/sw.js: ngsw-worker.js imported wholesale, plus Background
    // Sync for the gist outbox. A registration is keyed by scope rather than by
    // script URL, so installs still running the plain ngsw worker move across on
    // their next update rather than ending up with two.
    provideServiceWorker('sw.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
};

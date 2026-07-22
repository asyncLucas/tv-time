import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';
import { Onboarding } from './features/onboarding/onboarding';
import {
  LucideAngularModule,
  Play,
  LayoutGrid,
  Film,
  ListVideo,
  UserRound,
  Settings,
  Download,
  X,
  Share,
} from 'lucide-angular';
import { LibraryStore } from './core/library.store';
import { DeviceService } from './core/device.service';
import { SyncService } from './core/sync.service';
import { GistSyncService } from './core/gist-sync.service';
import { PwaService } from './core/pwa.service';
import { LocalConfigService } from './core/local-config.service';

/**
 * Does this URL name a route a stranger may reach without a library?
 *
 * Deliberately suffix-anchored rather than `^`-anchored, so it reads both the
 * router's app-internal URL (`/u/abc`) and a raw pathname carrying the deployed
 * base href (`/tv-time/u/abc`). Query and fragment are stripped first — `/link`
 * carries its one-time payload in the fragment.
 */
export function isGuestRoute(url: string): boolean {
  return /\/(link|u\/[^/]+)\/?$/.test(url.split(/[?#]/)[0]);
}

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule, Onboarding],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private store = inject(LibraryStore);
  private router = inject(Router);
  private config = inject(LocalConfigService);
  private devices = inject(DeviceService);
  protected sync = inject(SyncService);
  protected gist = inject(GistSyncService);
  protected pwa = inject(PwaService);
  protected readonly ready = signal(false);
  protected readonly error = signal<string | null>(null);
  /**
   * Two routes are exempt from the onboarding gate, because a visitor to either
   * has no library *by definition*:
   *
   *  - `/link`, reached from a QR code — onboarding first would swallow the
   *    one-time code sitting in the URL.
   *  - `/u/:id`, someone else's published profile — a stranger following a
   *    shared link is not here to import a backup.
   *
   * Re-evaluated on every navigation rather than read once at startup. The
   * exemption has to *end* when the visitor leaves: the public profile page
   * offers them a link into the app, and a one-shot check would carry the
   * bypass along with them, leaving a library-less device staring at an empty
   * app with no way to onboard short of a full reload.
   *
   * Seeded from `location.pathname` so the very first paint is right even
   * before the router's initial navigation settles; both forms are matched by
   * the same suffix-anchored pattern, base href and all.
   */
  private readonly guestRoute = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => isGuestRoute(e.urlAfterRedirects)),
    ),
    { initialValue: isGuestRoute(location.pathname) },
  );
  /** Has this device set up a library yet? (else show onboarding) */
  protected readonly hasLibrary = computed(() => this.store.hasLibrary() || this.guestRoute());

  // lucide icon refs exposed to the template for the install button + banner
  protected readonly DownloadIcon = Download;
  protected readonly XIcon = X;
  protected readonly ShareIcon = Share;

  protected readonly nav = [
    { path: '', label: 'Up Next', icon: Play, exact: true },
    { path: 'shows', label: 'Shows', icon: LayoutGrid, exact: false },
    { path: 'movies', label: 'Movies', icon: Film, exact: false },
    { path: 'lists', label: 'Lists', icon: ListVideo, exact: false },
    { path: 'profile', label: 'Profile', icon: UserRound, exact: false },
    { path: 'settings', label: 'Settings', icon: Settings, exact: false },
  ];

  constructor() {
    this.pwa.init();
    Promise.all([this.store.init(), this.config.init()])
      .then(() => {
        this.ready.set(true);
        this.sync.autoStart(); // WebRTC P2P, if configured
        this.gist.autoStart(); // GitHub Gist cloud sync, if configured
        // Identity + session roster (needs config). Non-fatal: a library that
        // loaded shouldn't be replaced by an error screen over the device list.
        return this.devices.init().catch(() => undefined);
      })
      .catch((e) => this.error.set(String(e?.message ?? e)));
  }
}

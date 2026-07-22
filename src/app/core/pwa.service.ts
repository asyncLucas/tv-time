import { Injectable, computed, inject, signal } from '@angular/core';
import { SwUpdate, VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs/operators';

/** The (non-standard) beforeinstallprompt event, typed for our use. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Progressive Web App lifecycle:
 *  - captures the browser's install prompt so we can offer an in-app "Install"
 *    affordance instead of relying on a hidden browser menu, and
 *  - watches the service worker for a freshly deployed version and force-reloads
 *    into it automatically so every device converges on the latest build.
 *
 * The service worker itself is only active in production builds (see
 * app.config.ts), so all of this is inert under `ng serve` — by design.
 */
@Injectable({ providedIn: 'root' })
export class PwaService {
  private swUpdate = inject(SwUpdate, { optional: true });

  private deferredPrompt: BeforeInstallPromptEvent | null = null;

  private static readonly DISMISS_KEY = 'pwa-install-dismissed';

  /** True when the browser has offered an install prompt we can replay. */
  readonly canInstall = signal(false);
  /** True once the app is running as an installed PWA. */
  readonly installed = signal(false);
  /** True once a new version has been found and we're force-reloading into it. */
  readonly updateReady = signal(false);
  /** Guards against a double activate/reload if two version events race. */
  private updating = false;
  /** Per-device dismissal of the mobile install banner (persisted, not synced). */
  readonly bannerDismissed = signal(localStorage.getItem(PwaService.DISMISS_KEY) === '1');

  /**
   * iOS never fires `beforeinstallprompt` and exposes no programmatic install —
   * Add to Home Screen lives behind the Share sheet. So there is nothing to
   * capture and `canInstall` stays false forever; we detect the platform instead
   * and show instructions rather than a button.
   */
  readonly isIos = signal(false);

  /** Show the iOS "Add to Home Screen" hint instead of an install button. */
  readonly iosInstallHint = computed(() => this.isIos() && !this.installed());

  /** Anything to offer? (a replayable prompt, or the iOS manual route) */
  readonly showInstallBanner = computed(
    () => (this.canInstall() || this.iosInstallHint()) && !this.bannerDismissed(),
  );

  init(): void {
    this.isIos.set(PwaService.detectIos());
    // already installed? (standalone display mode)
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      // iOS Safari
      (navigator as any).standalone === true;
    this.installed.set(!!standalone);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault(); // stop Chrome's mini-infobar; we drive it ourselves
      this.deferredPrompt = e as BeforeInstallPromptEvent;
      this.canInstall.set(true);
    });

    window.addEventListener('appinstalled', () => {
      this.installed.set(true);
      this.canInstall.set(false);
      this.deferredPrompt = null;
    });

    if (this.swUpdate?.isEnabled) {
      // A freshly deployed build has finished downloading → force-reload into it.
      this.swUpdate.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => this.forceUpdate());
      // A corrupt/lost SW state can't self-heal in place — a hard reload re-fetches it.
      this.swUpdate.unrecoverable.subscribe(() => location.reload());
      // proactively poll for a new deploy every 30 min
      setInterval(() => this.swUpdate!.checkForUpdate().catch(() => {}), 30 * 60 * 1000);
    }
  }

  /** iPhone/iPod, plus iPadOS — which reports itself as a touch-capable Mac. */
  private static detectIos(): boolean {
    const ua = navigator.userAgent;
    return (
      /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  /** Dismiss the mobile install banner for good (on this device). */
  dismissInstall(): void {
    localStorage.setItem(PwaService.DISMISS_KEY, '1');
    this.bannerDismissed.set(true);
  }

  /** Replay the captured install prompt. Returns whether the user accepted. */
  async promptInstall(): Promise<boolean> {
    if (!this.deferredPrompt) return false;
    await this.deferredPrompt.prompt();
    const { outcome } = await this.deferredPrompt.userChoice;
    this.deferredPrompt = null;
    this.canInstall.set(false);
    return outcome === 'accepted';
  }

  /**
   * Activate the freshly downloaded version and reload into it. Runs
   * automatically the moment a new build is ready; data is safe because it lives
   * in IndexedDB/the CRDT, not in page memory. `updateReady` flips first so the
   * UI can flash a brief "Updating…" note before the reload lands.
   */
  private async forceUpdate(): Promise<void> {
    if (!this.swUpdate?.isEnabled || this.updating) return;
    this.updating = true;
    this.updateReady.set(true);
    try {
      await this.swUpdate.activateUpdate();
    } catch {
      // Activation can fail if the new SW is already controlling; reload anyway.
    } finally {
      location.reload();
    }
  }
}

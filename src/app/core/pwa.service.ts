import { Injectable, inject, signal } from '@angular/core';
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
 *  - watches the service worker for a freshly deployed version so the user can
 *    refresh into it on their terms.
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
  /** True when a newer version has been downloaded and is ready to activate. */
  readonly updateReady = signal(false);
  /** Per-device dismissal of the mobile install banner (persisted, not synced). */
  readonly bannerDismissed = signal(localStorage.getItem(PwaService.DISMISS_KEY) === '1');

  init(): void {
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
      this.swUpdate.versionUpdates
        .pipe(filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'))
        .subscribe(() => this.updateReady.set(true));
      // proactively poll for a new deploy every 30 min
      setInterval(() => this.swUpdate!.checkForUpdate().catch(() => {}), 30 * 60 * 1000);
    }
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

  /** Activate the downloaded update and reload into it. */
  async applyUpdate(): Promise<void> {
    if (!this.swUpdate?.isEnabled) return;
    await this.swUpdate.activateUpdate();
    location.reload();
  }
}

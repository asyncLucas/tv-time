import { Injectable, signal } from '@angular/core';

/**
 * Whether this device currently has a network connection.
 *
 * `navigator.onLine` is only trustworthy in one direction: false really does
 * mean there is no link, while true only means the OS has *an* interface up —
 * a captive portal or a dead uplink still reports online. That asymmetry suits
 * the one thing we use it for, which is telling the user when nothing can
 * reach the network; anything that actually needs data still falls back to its
 * own cache on failure (see TmdbService's stale-on-failure read path).
 */
@Injectable({ providedIn: 'root' })
export class NetworkService {
  readonly online = signal(navigator.onLine);

  constructor() {
    window.addEventListener('online', () => this.online.set(true));
    window.addEventListener('offline', () => this.online.set(false));
  }
}

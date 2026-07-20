import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
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
} from 'lucide-angular';
import { LibraryStore } from './core/library.store';
import { SyncService } from './core/sync.service';
import { PwaService } from './core/pwa.service';
import { LocalConfigService } from './core/local-config.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, LucideAngularModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private store = inject(LibraryStore);
  private config = inject(LocalConfigService);
  protected sync = inject(SyncService);
  protected pwa = inject(PwaService);
  protected readonly ready = signal(false);
  protected readonly error = signal<string | null>(null);

  // lucide icon refs exposed to the template for the install button + banner
  protected readonly DownloadIcon = Download;
  protected readonly XIcon = X;

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
        this.sync.autoStart(); // reconnects if device-local sync config exists
      })
      .catch((e) => this.error.set(String(e?.message ?? e)));
  }
}

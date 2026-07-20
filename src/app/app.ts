import { Component, inject, signal } from '@angular/core';
import { RouterOutlet, RouterLink, RouterLinkActive } from '@angular/router';
import { LibraryStore } from './core/library.store';
import { SyncService } from './core/sync.service';
import { PwaService } from './core/pwa.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private store = inject(LibraryStore);
  protected sync = inject(SyncService);
  protected pwa = inject(PwaService);
  protected readonly ready = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly nav = [
    { path: '', label: 'Up Next', icon: '▶', exact: true },
    { path: 'shows', label: 'Shows', icon: '▦', exact: false },
    { path: 'movies', label: 'Movies', icon: '◱', exact: false },
    { path: 'lists', label: 'Lists', icon: '☰', exact: false },
    { path: 'profile', label: 'Profile', icon: '◉', exact: false },
    { path: 'settings', label: 'Settings', icon: '⚙', exact: false },
  ];

  constructor() {
    this.pwa.init();
    this.store
      .init()
      .then(() => {
        this.ready.set(true);
        this.sync.autoStart();
      })
      .catch((e) => this.error.set(String(e?.message ?? e)));
  }
}

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { LibraryStore } from '../core/library.store';
import { addedKey } from '../core/doc.service';
import { TMDB_UNREACHABLE, TmdbService, TmdbSearchResult } from '../core/tmdb.service';
import { InitialsPipe } from './initials';

/**
 * Discovery: search TMDB for a title that isn't in the catalog yet and add it.
 *
 * Sits underneath the Shows/Movies pages as a progressive enhancement — the
 * local filter above it is unchanged and still instant. This only reaches the
 * network once the query is long enough and settles, so typing doesn't fire a
 * request per keystroke.
 *
 * Without a TMDB key there is nothing to search, so the whole block renders a
 * short pointer to Settings instead.
 */
@Component({
  selector: 'app-title-search',
  imports: [RouterLink, InitialsPipe],
  template: `
    @if (query().trim().length >= 2) {
      <section class="ts">
        <header class="ts-head">
          <h2>
            @if (kind() === 'show') { Add a show } @else { Add a film }
            <span class="ts-q">“{{ query().trim() }}”</span>
          </h2>
          @if (searching()) { <span class="ts-status">Searching TMDB…</span> }
        </header>

        @if (!tmdb.hasKey()) {
          <p class="ts-empty">
            Searching needs a free <a routerLink="/settings">TMDB key</a> — add one to find titles
            beyond your catalog.
          </p>
        } @else if (error()) {
          <p class="ts-empty err">{{ error() }}</p>
        } @else if (!searching() && !results().length) {
          <p class="ts-empty">Nothing on TMDB matches that.</p>
        } @else {
          <div class="ts-grid">
            @for (c of cards(); track c.result.tmdbId) {
              <article class="ts-card">
                <a class="ts-open" [routerLink]="c.link" [title]="c.openTitle">
                  <div class="ts-poster">
                    @if (c.poster; as src) {
                      <img [src]="src" [alt]="c.result.name" loading="lazy" decoding="async" />
                    } @else {
                      <span class="ts-ph">{{ c.result.name | initials }}</span>
                    }
                  </div>
                  <div class="ts-meta">
                    <div class="ts-name" [title]="c.result.name">{{ c.result.name }}</div>
                    <div class="ts-year">{{ c.result.year || '—' }}</div>
                  </div>
                </a>
                @if (c.inLibrary) {
                  <button class="ts-add in" disabled>✓ In library</button>
                } @else {
                  <button
                    class="ts-add"
                    [disabled]="adding() === c.result.tmdbId"
                    (click)="add(c.result)"
                  >
                    {{ adding() === c.result.tmdbId ? 'Adding…' : '+ Add' }}
                  </button>
                }
              </article>
            }
          </div>
        }
      </section>
    }
  `,
  styles: [
    `
      .ts {
        margin-top: 40px;
        border-top: 1px solid var(--line-soft);
        padding-top: 22px;
      }
      .ts-head {
        display: flex;
        align-items: baseline;
        gap: 12px;
        margin-bottom: 16px;
      }
      .ts-head h2 {
        font-size: 15px;
        margin: 0;
      }
      .ts-q {
        color: var(--text-dim);
        font-weight: 500;
      }
      .ts-status {
        font-size: 12px;
        color: var(--text-faint);
      }
      .ts-empty {
        color: var(--text-dim);
        font-size: 13px;
      }
      .ts-empty.err {
        color: var(--bad);
      }
      .ts-empty a {
        color: var(--gold);
        text-decoration: underline;
      }
      .ts-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
        gap: 16px;
      }
      .ts-card {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .ts-open {
        display: flex;
        flex-direction: column;
        gap: 8px;
        color: inherit;
        text-decoration: none;
        cursor: pointer;
      }
      .ts-open:hover .ts-name {
        color: var(--gold);
      }
      .ts-open:hover .ts-poster {
        outline: 2px solid var(--gold-soft);
        outline-offset: 2px;
      }
      .ts-poster {
        position: relative;
        aspect-ratio: 2 / 3;
        border-radius: 10px;
        overflow: hidden;
        background: var(--bg-elev-2);
        display: grid;
        place-items: center;
      }
      .ts-poster img {
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .ts-ph {
        color: var(--text-faint);
        font-weight: 800;
        font-size: 20px;
      }
      .ts-name {
        font-size: 13px;
        font-weight: 600;
        line-height: 1.3;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .ts-year {
        font-size: 11.5px;
        color: var(--text-faint);
        margin-top: 2px;
      }
      .ts-add {
        border: 1px solid var(--line);
        background: transparent;
        color: var(--text);
        border-radius: 8px;
        padding: 6px 0;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .ts-add:hover:not(:disabled) {
        background: var(--gold-soft);
        color: var(--gold);
        border-color: transparent;
      }
      .ts-add:disabled {
        cursor: default;
        color: var(--text-faint);
      }
      .ts-add.in {
        color: var(--good);
        border-color: transparent;
      }
    `,
  ],
  // All bindings read signals or `cards()`, which resolves the per-result work.
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TitleSearch {
  store = inject(LibraryStore);
  tmdb = inject(TmdbService);
  private router = inject(Router);

  readonly kind = input.required<'show' | 'movie'>();
  readonly query = input('');

  readonly results = signal<TmdbSearchResult[]>([]);
  readonly searching = signal(false);
  readonly error = signal<string | null>(null);
  readonly adding = signal<number | null>(null);

  /** Identifies the newest search, so a slow earlier one can't overwrite it. */
  private runId = 0;
  private debounce?: ReturnType<typeof setTimeout>;

  constructor() {
    effect(() => {
      const q = this.query().trim();
      const kind = this.kind();
      const ready = this.tmdb.hasKey();

      clearTimeout(this.debounce);
      if (q.length < 2 || !ready) {
        this.results.set([]);
        this.searching.set(false);
        return;
      }
      this.searching.set(true);
      this.debounce = setTimeout(() => this.run(kind, q), DEBOUNCE_MS);
    });
  }

  private async run(kind: 'show' | 'movie', q: string): Promise<void> {
    const run = ++this.runId;
    this.error.set(null);
    try {
      const found =
        kind === 'show' ? await this.tmdb.searchShows(q) : await this.tmdb.searchMovies(q);
      if (run !== this.runId) return; // a newer query already superseded this
      this.results.set(found);
    } catch {
      if (run !== this.runId) return;
      this.results.set([]);
      this.error.set(TMDB_UNREACHABLE);
    } finally {
      if (run === this.runId) this.searching.set(false);
    }
  }

  async add(r: TmdbSearchResult): Promise<void> {
    if (this.adding() !== null) return;
    this.adding.set(r.tmdbId);
    this.error.set(null);
    try {
      const kind = this.kind();
      const uuid =
        kind === 'show' ? await this.store.addShow(r) : await this.store.addMovie(r);
      this.router.navigate(['/', kind === 'show' ? 'shows' : 'movies', uuid]);
    } catch (e: any) {
      this.error.set(`Could not add “${r.name}”: ${e?.message ?? e}`);
    } finally {
      this.adding.set(null);
    }
  }

  /**
   * Result rows with their link, poster URL and library flag resolved once.
   *
   * `detailLink()` in particular returned a fresh array on every call, so
   * RouterLink re-processed its commands for all 20 results on every change
   * detection cycle. The uuid in the link is the deterministic added-key, so the
   * detail page previews the title straight from TMDB when it isn't in the
   * library yet and resolves to the real entry once it is — same link either way.
   */
  readonly cards = computed(() => {
    const kind = this.kind();
    const segment = kind === 'show' ? 'shows' : 'movies';
    return this.results().map((r) => ({
      result: r,
      link: ['/', segment, addedKey(kind, r.tmdbId)],
      poster: this.tmdb.poster(r.posterPath, 'w185'),
      inLibrary: this.store.isInLibrary(kind, r.tmdbId),
      openTitle: `View details for ${r.name}`,
    }));
  });
}

/** Long enough that typing a title doesn't fire a request per keystroke. */
const DEBOUNCE_MS = 400;

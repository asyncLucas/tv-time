import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Title } from '@angular/platform-browser';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { loadPublicProfile, type PublicProfile } from '../../core/public-profile.service';
import { formatDuration } from '../../shared/duration';
import { Poster } from '../../shared/poster';
import { WheelX } from '../../shared/wheel-x';

/**
 * Somebody's shared profile, read from their public gist.
 *
 * The only page in the app that renders a document this device did not write, so
 * it is deliberately inert: no store, no CRDT, no writes, nothing clickable that
 * leads anywhere but back to the app. Everything on screen came through
 * `parsePublicProfile`, which is where the field-by-field vetting lives.
 *
 * It shows what the owner chose to publish — headline totals, favourites,
 * genres. Not the screen-time breakdown: when and how much someone watches day
 * by day is the most personal thing on the private page, and it is nobody's
 * business at a link.
 *
 * A profile that was never public, or that has since been made private again,
 * is a 404 at GitHub and reads here as "not available" — the same answer either
 * way, so an old link can't confirm a page ever existed.
 */
@Component({
  selector: 'app-public-profile',
  imports: [RouterLink, Poster, WheelX],
  template: `
    <div class="page">
      @switch (state()) {
        @case ('loading') {
          <div class="note">Loading profile…</div>
        }
        @case ('missing') {
          <div class="note">
            <h1>Profile not available</h1>
            <p>
              This profile is private, or the link has been taken down. Only profiles their owner
              has explicitly made public can be viewed here.
            </p>
            <a class="cta" routerLink="/">Go to TV Time</a>
          </div>
        }
        @case ('error') {
          <div class="note">
            <h1>Couldn't load this profile</h1>
            <p>{{ error() }}</p>
          </div>
        }
        @case ('ready') {
          @if (profile(); as p) {
            <div class="banner">
              @if (p.banner) {
                <img class="banner-img" [src]="p.banner" alt="" width="1024" height="341" />
              }
              <div class="banner-scrim" aria-hidden="true"></div>
            </div>

            <div class="head">
              @if (p.image) {
                <img class="avatar" [src]="p.image" [alt]="p.name || 'Profile picture'" />
              } @else {
                <span class="avatar placeholder">{{ initial(p.name) }}</span>
              }
              <div>
                <h1 class="name">{{ p.name || 'A TV Time profile' }}</h1>
                <div class="sub">
                  @if (p.login) { &#64;{{ p.login }} }
                  @if (memberSince()) { · member since {{ memberSince() }} }
                </div>
              </div>
            </div>

            <div class="grid">
              <div class="tile big gold">
                <div class="n">{{ lifetime() }}</div>
                <div class="l">
                  tv time
                  @if (hours()) { · {{ hours() }} hours }
                </div>
              </div>
              <div class="tile">
                <div class="n">{{ p.stats.showsFollowed }}</div>
                <div class="l">shows followed</div>
              </div>
              <div class="tile">
                <div class="n">{{ p.stats.showsCompleted }}</div>
                <div class="l">shows completed</div>
              </div>
              <div class="tile">
                <div class="n">{{ p.stats.moviesWatched }}</div>
                <div class="l">movies watched</div>
              </div>
              <div class="tile">
                <div class="n">{{ p.stats.episodesWatched }}</div>
                <div class="l">episodes logged</div>
              </div>
              <div class="tile">
                <div class="n">{{ p.stats.showsFavorite }}</div>
                <div class="l">favorite shows</div>
              </div>
            </div>

            @if (p.favoriteShows.length) {
              <h2>Favorite shows</h2>
              <div class="rail" appWheelX>
                @for (s of p.favoriteShows; track $index) {
                  <div class="fav">
                    <app-poster [title]="s.name" [cachedPoster]="s.poster" />
                    <div class="fav-name">{{ s.name }}</div>
                  </div>
                }
              </div>
            }

            @if (p.favoriteMovies.length) {
              <h2>Favorite movies</h2>
              <div class="rail" appWheelX>
                @for (m of p.favoriteMovies; track $index) {
                  <div class="fav">
                    <app-poster [title]="m.name" [cachedPoster]="m.poster" />
                    <div class="fav-name">{{ m.name }}</div>
                    <div class="fav-yr">{{ m.year }}</div>
                  </div>
                }
              </div>
            }

            @if (p.genres.length) {
              <h2>Top genres</h2>
              <div class="genres">
                @for (g of p.genres; track g.name) {
                  <div class="genre">
                    <div class="gr-head">
                      <span>{{ g.name }}</span>
                      <span class="gr-n">{{ g.count }}</span>
                    </div>
                    <div class="gr-bar"><div class="gr-fill" [style.width.%]="g.pct"></div></div>
                  </div>
                }
              </div>
            }

            <div class="src">
              A public profile shared from <a routerLink="/">TV Time Revival</a> — a local-first
              tracker with no accounts and no server. This page is a snapshot its owner published
              {{ published() }}; they can take it down at any time.
            </div>
          }
        }
      }
    </div>
  `,
  styles: [
    `
      /* Trimmed from the owner's profile page rather than shared with it: this
         view has no edit affordances at all, and the two only need to agree on
         the shape of the thing, not on every rule. */
      .banner {
        position: relative;
        height: 210px;
        border-radius: var(--radius);
        overflow: hidden;
        background: linear-gradient(120deg, var(--bg-elev) 0%, var(--bg-elev-2) 100%);
      }
      .banner-img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .banner-scrim {
        position: absolute;
        inset: 0;
        background: linear-gradient(
          180deg,
          rgba(12, 13, 16, 0.15) 0%,
          rgba(12, 13, 16, 0.45) 55%,
          rgba(12, 13, 16, 0.96) 100%
        );
      }
      .head {
        position: relative;
        z-index: 1;
        display: flex;
        align-items: flex-end;
        gap: 20px;
        margin: -56px 0 36px;
        padding-left: 28px;
      }
      .avatar {
        width: 112px;
        height: 112px;
        border-radius: 50%;
        object-fit: cover;
        display: block;
        flex-shrink: 0;
        border: 4px solid var(--bg);
        box-shadow:
          0 0 0 1px var(--gold),
          0 10px 28px rgba(0, 0, 0, 0.6);
      }
      .avatar.placeholder {
        display: grid;
        place-items: center;
        background: linear-gradient(145deg, #2a2620 0%, var(--bg-elev-2) 70%);
        color: var(--gold);
        font-size: 42px;
        font-weight: 800;
        line-height: 1;
      }
      .name {
        font-size: 32px;
        font-weight: 800;
        letter-spacing: -0.02em;
        margin: 0;
        line-height: 1.15;
      }
      .sub {
        color: var(--text-dim);
        font-size: 13.5px;
        margin-top: 6px;
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 14px;
        margin-bottom: 40px;
      }
      .tile {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 20px;
      }
      .tile.big {
        grid-column: span 2;
      }
      .tile .n {
        font-size: 32px;
        font-weight: 800;
        letter-spacing: -0.02em;
      }
      .tile.gold .n {
        color: var(--gold);
        font-size: 40px;
      }
      .tile .l {
        color: var(--text-dim);
        font-size: 12.5px;
        font-weight: 600;
        margin-top: 4px;
      }
      h2 {
        font-size: 18px;
        margin: 0 0 16px;
      }
      .rail + h2 {
        margin-top: 36px;
      }
      .rail {
        display: flex;
        gap: 14px;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x proximity;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        padding-bottom: 4px;
      }
      .rail::-webkit-scrollbar {
        display: none;
      }
      .fav {
        flex: 0 0 132px;
        width: 132px;
        scroll-snap-align: start;
      }
      .fav-name {
        font-size: 13px;
        font-weight: 600;
        margin-top: 8px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
      }
      .fav-yr {
        color: var(--text-faint);
        font-size: 12px;
        margin-top: 2px;
      }
      .genres {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 14px 24px;
        max-width: 760px;
      }
      .gr-head {
        display: flex;
        justify-content: space-between;
        font-size: 13px;
        font-weight: 600;
        margin-bottom: 6px;
      }
      .gr-n {
        color: var(--text-faint);
      }
      .gr-bar {
        height: 6px;
        background: var(--bg-elev-2);
        border-radius: 999px;
        overflow: hidden;
      }
      .gr-fill {
        height: 100%;
        background: var(--gold);
        border-radius: 999px;
      }
      .src {
        margin-top: 48px;
        color: var(--text-faint);
        font-size: 12.5px;
        line-height: 1.6;
        max-width: 620px;
        border-top: 1px solid var(--line-soft);
        padding-top: 20px;
      }
      .src a {
        color: var(--gold);
      }
      /* Loading, private and error all land here — one centred block, so the
         page doesn't reflow into a different layout depending on the answer. */
      .note {
        max-width: 520px;
        margin: 64px auto;
        text-align: center;
        color: var(--text-dim);
      }
      .note h1 {
        font-size: 22px;
        margin: 0 0 10px;
        color: var(--text);
      }
      .note p {
        font-size: 14px;
        line-height: 1.6;
        margin: 0;
      }
      .cta {
        display: inline-block;
        margin-top: 20px;
        background: var(--gold);
        color: #1a1400;
        font-weight: 700;
        font-size: 13px;
        padding: 9px 18px;
        border-radius: 999px;
        text-decoration: none;
      }

      @media (max-width: 720px) {
        .banner {
          height: 148px;
        }
        .head {
          flex-direction: column;
          align-items: flex-start;
          gap: 12px;
          margin: -44px 0 28px;
          padding-left: 16px;
        }
        .avatar {
          width: 84px;
          height: 84px;
          border-width: 3px;
        }
        .avatar.placeholder {
          font-size: 32px;
        }
        .name {
          font-size: 26px;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PublicProfilePage {
  private route = inject(ActivatedRoute);
  private title = inject(Title);

  readonly state = signal<'loading' | 'ready' | 'missing' | 'error'>('loading');
  readonly profile = signal<PublicProfile | null>(null);
  readonly error = signal<string | null>(null);

  /**
   * Which load is current. A second navigation while the first fetch is still
   * in flight must not be overwritten by it when it lands — the answer to the
   * URL you *left* is not an answer to the one you are on.
   */
  private token = 0;

  constructor() {
    // Subscribed rather than read from the snapshot: Angular reuses this
    // component between two `/u/:id` URLs, so a constructor-time read would
    // leave the previous person's profile on screen under the new link.
    this.route.paramMap
      .pipe(takeUntilDestroyed())
      .subscribe((params) => void this.load(params.get('id') ?? ''));
  }

  private async load(id: string): Promise<void> {
    const mine = ++this.token;
    this.state.set('loading');
    this.profile.set(null);
    this.error.set(null);
    try {
      const profile = await loadPublicProfile(id);
      if (mine !== this.token) return; // superseded
      if (!profile) {
        this.state.set('missing');
        return;
      }
      this.profile.set(profile);
      this.state.set('ready');
      this.title.setTitle(profile.name ? `${profile.name} · TV Time` : 'Profile · TV Time');
    } catch (e: any) {
      if (mine !== this.token) return;
      this.error.set(String(e?.message ?? e));
      this.state.set('error');
    }
  }

  initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  readonly lifetime = computed(() => formatDuration(this.profile()?.lifetimeMinutes ?? 0));

  /** Mirrors the owner's page: hours are a footnote to the headline, not a repeat. */
  readonly hours = computed(() => {
    const mins = this.profile()?.lifetimeMinutes ?? 0;
    return mins < 60 * 24 ? '' : Math.floor(mins / 60).toLocaleString();
  });

  readonly memberSince = computed(() => {
    const raw = this.profile()?.memberSince;
    const year = raw ? new Date(raw).getFullYear() : NaN;
    return Number.isFinite(year) ? String(year) : '';
  });

  /** "on 4 Mar 2026" — a snapshot's age is the one thing a reader must know. */
  readonly published = computed(() => {
    const at = Date.parse(this.profile()?.publishedAt ?? '');
    if (!Number.isFinite(at)) return 'recently';
    return `on ${new Date(at).toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })}`;
  });
}

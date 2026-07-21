import { Component, computed, inject } from '@angular/core';
import { LibraryStore } from '../../core/library.store';

@Component({
  selector: 'app-profile',
  template: `
    <div class="page">
      @if (store.profile(); as p) {
        <div class="head">
          @if (p.name) {
            @if (p.image) { <img class="avatar" [src]="p.image" [alt]="p.name" /> }
            <div>
              <h1>{{ p.name }}</h1>
              <div class="sub">&#64;{{ p.login }} · member since {{ p.createdAt?.slice(0, 4) }} · {{ p.timezone }}</div>
            </div>
          } @else {
            <div>
              <h1>Your stats</h1>
              <div class="sub">Local-first — no account, no profile. Everything below is just yours.</div>
            </div>
          }
        </div>

        <div class="grid">
          <div class="tile big gold">
            <div class="n">{{ hours() }}</div>
            <div class="l">hours watched (lifetime)</div>
          </div>
          <div class="tile">
            <div class="n">{{ s().showsFollowed }}</div>
            <div class="l">shows followed</div>
          </div>
          <div class="tile">
            <div class="n">{{ s().showsCompleted }}</div>
            <div class="l">shows completed</div>
          </div>
          <div class="tile">
            <div class="n">{{ s().moviesWatched }}</div>
            <div class="l">movies watched</div>
          </div>
          <div class="tile">
            <div class="n">{{ s().episodesWatched }}</div>
            <div class="l">episodes logged</div>
          </div>
          <div class="tile">
            <div class="n">{{ s().showsFavorite }}</div>
            <div class="l">favorite shows</div>
          </div>
        </div>

        <h2>Top genres</h2>
        <div class="genres">
          @for (g of topGenres(); track g.name) {
            <div class="genre">
              <div class="gr-head">
                <span>{{ g.name }}</span>
                <span class="gr-n">{{ g.count }}</span>
              </div>
              <div class="gr-bar"><div class="gr-fill" [style.width.%]="g.pct"></div></div>
            </div>
          }
        </div>

        <div class="src">
          Restored from an on-device TV Time backup (synced ~Jan 2026). The service shut down;
          this app keeps your history alive, decentralized and yours.
        </div>
      }
    </div>
  `,
  styles: [
    `
      .head {
        display: flex;
        align-items: center;
        gap: 18px;
        margin-bottom: 32px;
      }
      .avatar {
        width: 72px;
        height: 72px;
        border-radius: 50%;
        object-fit: cover;
        border: 2px solid var(--gold);
      }
      .head h1 {
        font-size: 26px;
        font-weight: 800;
        margin: 0;
      }
      .sub {
        color: var(--text-dim);
        font-size: 13.5px;
        margin-top: 4px;
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
    `,
  ],
})
export class Profile {
  store = inject(LibraryStore);
  s = this.store.stats;

  hours = computed(() => Math.round((this.store.stats().lifetimeMinutes || 0) / 60).toLocaleString());

  topGenres = computed(() => {
    const counts: Record<string, number> = {};
    for (const s of this.store.shows()) for (const g of s.genres) counts[g] = (counts[g] ?? 0) + 1;
    for (const m of this.store.movies()) for (const g of m.genres) counts[g] = (counts[g] ?? 0) + 1;
    const arr = Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const max = arr[0]?.count || 1;
    return arr.map((g) => ({ ...g, pct: Math.round((g.count / max) * 100) }));
  });
}

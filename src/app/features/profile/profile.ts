import { Component, computed, inject, signal } from '@angular/core';
import { LibraryStore } from '../../core/library.store';
import { formatDuration } from '../../shared/duration';
import { YearPipe } from '../../shared/year';

@Component({
  selector: 'app-profile',
  imports: [YearPipe],
  template: `
    <div class="page">
      @if (store.profile(); as p) {
        <div class="head">
          <button class="avatar-btn" (click)="picker.click()" [disabled]="busy()"
                  [title]="photo() ? 'Change picture' : 'Add a picture'">
            @if (photo(); as img) {
              <img
                class="avatar"
                [src]="img"
                [alt]="p.name || 'Profile picture'"
                (error)="brokenSrc.set(img)"
              />
            } @else {
              <span class="avatar placeholder">{{ initial(p.name) }}</span>
            }
            <span class="avatar-hint">{{ busy() ? '…' : 'Edit' }}</span>
          </button>
          <input #picker type="file" accept="image/*" hidden (change)="onPick($event)" />

          <div>
            @if (editing()) {
              <input class="name-input" [value]="p.name" placeholder="Your name" autofocus
                     (keydown.enter)="saveName($any($event.target).value)"
                     (blur)="saveName($any($event.target).value)" />
            } @else {
              <h1 class="name" (click)="editing.set(true)" title="Click to rename">
                {{ p.name || 'Your stats' }}
              </h1>
            }
            @if (p.name && p.login) {
              <div class="sub">&#64;{{ p.login }} · member since {{ p.createdAt | year }} · {{ p.timezone }}</div>
            } @else {
              <div class="sub">Local-first — no account. Your name and picture sync to your own devices.</div>
            }
            @if (photo()) {
              <button class="link" (click)="store.clearProfileImage()">Remove picture</button>
            }
          </div>
        </div>
        @if (error(); as e) { <div class="err">{{ e }}</div> }

        <div class="grid">
          <div class="tile big gold">
            <div class="n">{{ lifetime() }}</div>
            <div class="l">
              watched (lifetime)
              @if (hours()) { · {{ hours() }} hours }
            </div>
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
        display: block;
      }
      .avatar.placeholder {
        display: grid;
        place-items: center;
        background: var(--bg-elev-2);
        color: var(--gold);
        font-size: 28px;
        font-weight: 800;
      }
      .avatar-btn {
        position: relative;
        padding: 0;
        border: 0;
        background: none;
        cursor: pointer;
        border-radius: 50%;
        line-height: 0;
        flex-shrink: 0;
        /* keep the hover "Edit" strip inside the circle */
        overflow: hidden;
      }
      .avatar-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      .avatar-hint {
        position: absolute;
        inset: auto 0 0 0;
        background: rgba(0, 0, 0, 0.6);
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        line-height: 18px;
        border-radius: 0 0 36px 36px;
        opacity: 0;
        transition: opacity 0.15s;
      }
      .avatar-btn:hover .avatar-hint,
      .avatar-btn:focus-visible .avatar-hint {
        opacity: 1;
      }
      .name {
        cursor: text;
      }
      .name-input {
        font-size: 26px;
        font-weight: 800;
        background: var(--bg-elev);
        color: inherit;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 2px 8px;
      }
      .link {
        background: none;
        border: 0;
        padding: 0;
        margin-top: 6px;
        color: var(--text-faint);
        font-size: 12px;
        cursor: pointer;
        text-decoration: underline;
      }
      .err {
        color: #ff6b6b;
        font-size: 13px;
        margin: -20px 0 24px;
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

  editing = signal(false);
  busy = signal(false);
  error = signal<string | null>(null);

  /**
   * The avatar src that failed to load, if any. Backups restored from TV Time
   * carry a profile-picture URL on its now-dead CDN, so the <img> 404s; a fresh
   * upload (a synced data: URI) simply changes the src, which clears this. When
   * the current picture is this value we render the initial placeholder instead
   * of a broken image.
   */
  brokenSrc = signal<string | null>(null);

  /** The avatar to show: the profile picture, or null once it has failed to load. */
  readonly photo = computed(() => {
    const img = this.store.profile()?.image;
    return img && this.brokenSrc() !== img ? img : null;
  });

  initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  saveName(value: string): void {
    this.store.setProfileName(value);
    this.editing.set(false);
  }

  async onPick(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // let the same file be re-picked after an error
    if (!file) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.store.setProfileImage(file);
    } catch (e: any) {
      this.error.set(String(e?.message ?? e));
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * The hour total backing the headline duration. Floored, not rounded — the
   * headline floors too, and "1 hour · 2 hours" in one tile is worse than
   * losing a fraction. Suppressed below a day, where the headline already reads
   * in hours and would only repeat itself.
   */
  hours = computed(() => {
    const mins = this.store.stats().lifetimeMinutes || 0;
    return mins < 60 * 24 ? '' : Math.floor(mins / 60).toLocaleString();
  });
  // Compact ("3y 4mo"), not the long prose form: this tile renders at 40px, and
  // "3 years, 4 months, 12 days" wraps to three lines at any realistic total.
  lifetime = computed(() => formatDuration(this.store.stats().lifetimeMinutes));

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

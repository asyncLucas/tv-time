import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  signal,
  viewChild,
  type WritableSignal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { LibraryStore } from '../../core/library.store';
import { PublicProfileService } from '../../core/public-profile.service';
import { ConfirmDialog } from '../../shared/confirm-dialog';
import { formatDuration } from '../../shared/duration';
import { Poster } from '../../shared/poster';
import { YearPipe } from '../../shared/year';
import { ScreenTime } from './screen-time';

/**
 * Focus a field that has just replaced the text it edits, with whatever it holds
 * pre-selected so typing replaces rather than appends. `select()` alone is not
 * enough — on an empty input it selects nothing and leaves focus where it was,
 * which is exactly the case of a profile that has no handle yet.
 */
function focusAndSelect(el: HTMLInputElement | undefined): void {
  el?.focus();
  el?.select();
}

@Component({
  selector: 'app-profile',
  imports: [YearPipe, RouterLink, Poster, ScreenTime, ConfirmDialog],
  template: `
    <div class="page">
      @if (store.profile(); as p) {
        <div class="banner">
          @if (p.banner) {
            <!-- Intrinsic size matches what setProfileBanner encodes (1024×341),
                 so the box is reserved before the data URI decodes. It is the
                 largest image on the page and the likely LCP element. -->
            <img
              class="banner-img"
              [src]="p.banner"
              alt=""
              width="1024"
              height="341"
              decoding="async"
            />
          } @else if (coverPosters().length) {
            <!-- No cover picked: the library is better material than an empty
                 box, so the poster art stands in as one until they pick one. -->
            <div class="banner-strip" aria-hidden="true">
              @for (src of coverPosters(); track $index) {
                <img [src]="src" alt="" loading="lazy" decoding="async" (error)="hideBroken($event)" />
              }
            </div>
          }
          <!-- Fades the cover into the page colour at the bottom, so whatever is
               behind it the avatar and name below read cleanly. -->
          <div class="banner-scrim" aria-hidden="true"></div>
          <div class="banner-actions">
            <button class="banner-btn" (click)="bannerPicker.click()" [disabled]="bannerBusy()">
              {{ bannerBusy() ? 'Working…' : p.banner ? 'Change cover' : 'Add a cover' }}
            </button>
            @if (p.banner) {
              <button class="banner-btn" (click)="store.clearProfileBanner()" [disabled]="bannerBusy()">
                Remove
              </button>
            }
          </div>
        </div>
        <input #bannerPicker type="file" accept="image/*" hidden (change)="onPickBanner($event)" />

        <div class="head">
          <button class="avatar-btn" (click)="picker.click()" [disabled]="busy()"
                  [title]="photo() ? 'Change picture' : 'Add a picture'">
            @if (photo(); as img) {
              <img
                class="avatar"
                [src]="img"
                [alt]="p.name || 'Profile picture'"
                decoding="async"
                (error)="brokenSrc.set(img)"
              />
            } @else {
              <span class="avatar placeholder">{{ initial(p.name) }}</span>
            }
            <span class="avatar-hint">{{ busy() ? '…' : photo() ? 'Change' : 'Add' }}</span>
          </button>
          <input #picker type="file" accept="image/*" hidden (change)="onPick($event)" />

          <div>
            @if (editing()) {
              <input #nameInput class="name-input" [value]="p.name" placeholder="Your name"
                     (keydown.enter)="saveName($any($event.target).value)"
                     (blur)="saveName($any($event.target).value)" />
            } @else {
              <h1 class="name" (click)="editing.set(true)" title="Click to rename">
                {{ p.name || 'Your stats' }}
              </h1>
            }
            <!-- The handle is editable in place, exactly like the name above it:
                 a backup arrives with TV Time's own login, and that is a name
                 from a dead service rather than one the user ever chose. -->
            <div class="sub">
              @if (editingLogin()) {
                <span class="at">&#64;</span>
                <input #loginInput class="login-input" [value]="p.login" placeholder="username"
                       maxlength="39"
                       (keydown.enter)="saveLogin($any($event.target).value)"
                       (keydown.escape)="editingLogin.set(false)"
                       (blur)="saveLogin($any($event.target).value)" />
              } @else {
                <button class="sub-edit" (click)="editingLogin.set(true)"
                        [title]="p.login ? 'Click to change your username' : 'Pick a username'">
                  {{ p.login ? '@' + p.login : 'Add a username' }}
                </button>
              }
              @if (p.createdAt) { <span>· member since {{ p.createdAt | year }}</span> }
              @if (p.timezone) { <span>· {{ p.timezone }}</span> }
            </div>
            @if (!p.name && !p.login) {
              <div class="sub">Local-first — no account. Your name and picture sync to your own devices.</div>
            }
            <div class="head-links">
              @if (photo()) {
                <button class="link" (click)="store.clearProfileImage()">Remove picture</button>
                <span class="sep" aria-hidden="true">·</span>
              }
              <!-- Sits beside "Remove picture" rather than in Settings: this is a
                   property of the profile you are looking at, and the whole point
                   is that you can see its state without going to find it. -->
              <button class="link" (click)="askToggle()" [disabled]="pub.busy()">
                @if (pub.busy()) { Working… }
                @else if (pub.isPublic()) { Make profile private }
                @else { Make profile public }
              </button>
            </div>
          </div>
        </div>
        @if (error(); as e) { <div class="err">{{ e }}</div> }
        @if (pub.error(); as e) { <div class="err">{{ e }}</div> }

        @if (pub.isPublic()) {
          <div class="share">
            <div class="share-head">
              <span class="badge">Public</span>
              <span>Anyone with this link can see this profile.</span>
            </div>
            <div class="share-row">
              <input
                class="share-url"
                readonly
                [value]="pub.url()"
                (focus)="$any($event.target).select()"
                aria-label="Public profile link"
              />
              <button class="btn" (click)="copyLink()">{{ copied() ? 'Copied' : 'Copy link' }}</button>
              <a class="btn" [href]="pub.url()" target="_blank" rel="noopener">Open</a>
            </div>
            <div class="share-foot">
              Snapshot published {{ publishedLabel() }} ·
              <button class="link" (click)="republish()" [disabled]="pub.busy()">Update now</button>
            </div>
          </div>
        }

        <app-confirm-dialog
          [open]="confirming() !== null"
          [heading]="
            confirming() === 'publish' ? 'Make your profile public?' : 'Make your profile private?'
          "
          [message]="confirmMessage()"
          [confirmLabel]="confirming() === 'publish' ? 'Publish' : 'Make private'"
          [danger]="confirming() === 'private'"
          (confirmed)="applyToggle()"
          (dismissed)="confirming.set(null)"
        />

        <div class="grid">
          <div class="tile big gold">
            <div class="n">{{ lifetime() }}</div>
            <div class="l">
              tv time
              @if (hours()) { · {{ hours() }} hours }
            </div>
          </div>
          <a class="tile" routerLink="/shows">
            <div class="n">{{ s().showsFollowed }}</div>
            <div class="l">shows followed</div>
          </a>
          <a class="tile" routerLink="/shows">
            <div class="n">{{ s().showsCompleted }}</div>
            <div class="l">shows completed</div>
          </a>
          <a class="tile" routerLink="/movies">
            <div class="n">{{ s().moviesWatched }}</div>
            <div class="l">movies watched</div>
          </a>
          <div class="tile">
            <div class="n">{{ s().episodesWatched }}</div>
            <div class="l">episodes logged</div>
          </div>
          <a class="tile" routerLink="/shows">
            <div class="n">{{ s().showsFavorite }}</div>
            <div class="l">favorite shows</div>
          </a>
        </div>

        <!-- Lifetime figures above, the last seven days here: the tiles say how
             much you have watched, this says what you are watching lately. -->
        <app-screen-time />

        @if (favShows().length) {
          <h2>Favorite shows</h2>
          <div class="rail">
            @for (s of favShows(); track s.uuid) {
              <a class="fav" [routerLink]="['/shows', s.uuid]">
                <app-poster [title]="s.name" [tvdbId]="s.tvdbId" [cachedPoster]="s.cachedPoster ?? null" />
                <div class="fav-name">{{ s.name }}</div>
              </a>
            }
          </div>
        }

        @if (favMovies().length) {
          <h2>Favorite movies</h2>
          <div class="rail">
            @for (m of favMovies(); track m.uuid) {
              <a class="fav" [routerLink]="['/movies', m.uuid]">
                <app-poster [title]="m.name" [imdbId]="m.imdbId" [cachedPoster]="m.cachedPoster ?? null" />
                <div class="fav-name">{{ m.name }}</div>
                <div class="fav-yr">{{ m.firstReleaseDate | year }}</div>
              </a>
            }
          </div>
        }

        @if (topGenres().length) {
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
        }

        <div class="src">
          Restored from an on-device TV Time backup (synced ~Jan 2026). The service shut down;
          this app keeps your history alive, decentralized and yours.
        </div>
      }
    </div>
  `,
  styles: [
    `
      /* Cover photo. Sits inside the page padding rather than bleeding to the
         window edge — the sidebar layout has no full-bleed slot, and a rounded
         card reads as deliberate where a clipped full-bleed strip would not. */
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
      /* Posters butt up against each other as one continuous strip — a shelf of
         covers, not a gallery of cards. They are backdrop, so no radius or gap. */
      .banner-strip {
        display: flex;
        height: 100%;
      }
      .banner-strip img {
        flex: 1 1 0;
        min-width: 0;
        height: 100%;
        object-fit: cover;
        filter: saturate(0.55);
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
      /* Heavier over the stand-in strip than over a chosen cover: a photo the
         user picked should be seen, a placeholder should stay backdrop. */
      .banner-strip + .banner-scrim {
        background: linear-gradient(
          180deg,
          rgba(12, 13, 16, 0.62) 0%,
          rgba(12, 13, 16, 0.74) 52%,
          rgba(12, 13, 16, 0.97) 100%
        );
      }
      /* Top-right, not bottom: the header now overlaps the cover's lower edge
         and would collide with buttons parked there. */
      .banner-actions {
        position: absolute;
        right: 12px;
        top: 12px;
        display: flex;
        gap: 8px;
      }
      .banner-btn {
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(4px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        color: #fff;
        border-radius: 999px;
        padding: 6px 14px;
        font-size: 12px;
        font-weight: 700;
        cursor: pointer;
      }
      .banner-btn:hover:not(:disabled) {
        background: rgba(0, 0, 0, 0.8);
      }
      .banner-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      /* The avatar hangs half off the cover's lower edge; the name and byline
         clear it and sit on the page, so neither needs a text shadow to stay
         readable. .banner is positioned and would paint over a static sibling,
         hence the stacking context here. */
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
        /* Cut out of the cover with a page-coloured ring, then traced in gold —
           a hairline keeps the accent without ringing the face in yellow. */
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
      .avatar-btn {
        position: relative;
        padding: 0;
        border: 0;
        background: none;
        cursor: pointer;
        border-radius: 50%;
        line-height: 0;
        flex-shrink: 0;
      }
      .avatar-btn:disabled {
        opacity: 0.6;
        cursor: default;
      }
      /* Covers the whole circle rather than banding its lower edge, so the label
         sits centred at any avatar size instead of against a fixed radius. */
      .avatar-hint {
        position: absolute;
        inset: 4px;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: rgba(12, 13, 16, 0.66);
        color: #fff;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.02em;
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
        color: var(--text-faint);
        font-size: 12px;
        cursor: pointer;
        text-decoration: underline;
      }
      .link:disabled {
        opacity: 0.6;
        cursor: default;
      }
      /* The two profile-level actions read as one row of small print under the
         byline. The separator is an element rather than a ::before on the second
         link, because a pseudo-element inside the button would be dragged under
         the same underline and read as part of the label. */
      .head-links {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-top: 8px;
      }
      .sep {
        color: var(--line);
        font-size: 12px;
      }
      /* Looks like the byline it sits in, behaves like the editable field it is
         — the same trade the name heading above makes. */
      .sub-edit {
        background: none;
        border: 0;
        padding: 0;
        font: inherit;
        color: inherit;
        cursor: text;
        text-decoration: underline dotted;
        text-underline-offset: 3px;
      }
      .sub-edit:hover {
        color: var(--text);
      }
      .at {
        color: var(--text-dim);
      }
      .login-input {
        font: inherit;
        background: var(--bg-elev);
        color: inherit;
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        padding: 1px 6px;
        width: 180px;
      }
      /* Only rendered while public, so it can afford to state the consequence
         plainly rather than hedge about what might be shared. */
      .share {
        background: var(--bg-elev);
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 16px 18px;
        margin: -16px 0 32px;
      }
      .share-head {
        display: flex;
        align-items: center;
        gap: 10px;
        font-size: 13px;
        color: var(--text-dim);
        margin-bottom: 12px;
      }
      .badge {
        background: var(--gold);
        color: #1a1400;
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        padding: 3px 9px;
        border-radius: 999px;
      }
      .share-row {
        display: flex;
        gap: 8px;
        align-items: center;
        flex-wrap: wrap;
      }
      .share-url {
        flex: 1 1 260px;
        min-width: 0;
        background: var(--bg-elev-2);
        border: 1px solid var(--line);
        border-radius: var(--radius-sm);
        color: var(--text-dim);
        font-size: 12.5px;
        padding: 8px 10px;
      }
      .share-foot {
        color: var(--text-faint);
        font-size: 12px;
        margin-top: 12px;
      }
      .err {
        color: #ff6b6b;
        font-size: 13px;
        margin: -20px 0 24px;
      }
      .head h1 {
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
        display: block;
        color: inherit;
      }
      /* Tiles that lead somewhere pick up the same hover the Up Next cards
         used to have. The rest are figures with nowhere to go. */
      a.tile:hover {
        border-color: #3a3f4a;
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
      /* One-line, swipeable on touch; the scrollbar is hidden because the
         posters running off the edge already read as "there's more". */
      .rail {
        display: flex;
        gap: 14px;
        overflow-x: auto;
        overflow-y: hidden;
        scroll-snap-type: x proximity;
        -webkit-overflow-scrolling: touch;
        scrollbar-width: none;
        /* let the cards breathe against the page edge on phones */
        padding-bottom: 4px;
      }
      .rail::-webkit-scrollbar {
        display: none;
      }
      .fav {
        flex: 0 0 132px;
        width: 132px;
        scroll-snap-align: start;
        text-decoration: none;
        color: inherit;
      }
      .fav-name {
        font-size: 13px;
        font-weight: 600;
        margin-top: 8px;
        /* keep every card the same height regardless of title length */
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

      @media (max-width: 720px) {
        .banner {
          height: 148px;
        }
        /* Fourteen posters across a phone would be 25px slivers — drop all but
           the first seven and let the rest widen back into recognisable covers. */
        .banner-strip img:nth-child(n + 8) {
          display: none;
        }
        /* Not enough width to sit the name beside the avatar without squeezing
           it to two or three lines, so it stacks underneath instead. */
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
        .head h1 {
          font-size: 26px;
        }
      }
    `,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Profile {
  store = inject(LibraryStore);
  pub = inject(PublicProfileService);
  s = this.store.stats;

  editing = signal(false);
  editingLogin = signal(false);
  busy = signal(false);
  /** Which toggle the confirm dialog is currently asking about. */
  confirming = signal<'publish' | 'private' | null>(null);
  copied = signal(false);

  private nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private loginInput = viewChild<ElementRef<HTMLInputElement>>('loginInput');

  constructor() {
    // Opening your own profile is the moment to catch a published page up with
    // the library behind it — throttled inside the service, so this is at most
    // one GitHub write per few hours rather than one per visit.
    void this.pub.refreshIfStale();

    // Focus whichever field just opened. The `autofocus` attribute can't do this
    // — the platform only honours it for elements present at page load, and
    // these are inserted by a control flow block long after. Both fields commit
    // on blur, so a field that never took focus also never saves.
    effect(() => {
      if (this.editing()) focusAndSelect(this.nameInput()?.nativeElement);
    });
    effect(() => {
      if (this.editingLogin()) focusAndSelect(this.loginInput()?.nativeElement);
    });
  }
  /** Tracked separately from `busy` so picking a cover doesn't disable the avatar. */
  bannerBusy = signal(false);
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

  /**
   * Poster art standing in for a cover nobody has picked yet. Sampled at a
   * stride across the library rather than off the top, so the strip spans the
   * whole collection instead of showing the first dozen titles alphabetically.
   * Empty below a threshold — a handful of posters stretched across the full
   * width reads as an accident, and the plain gradient is better than that.
   */
  readonly coverPosters = computed(() => {
    const pool = [...this.store.shows(), ...this.store.movies()]
      .map((x) => x.cachedPoster)
      .filter((p): p is string => !!p);
    const COUNT = 14;
    if (pool.length < COUNT) return [];
    const stride = Math.floor(pool.length / COUNT);
    return Array.from({ length: COUNT }, (_, i) => pool[i * stride]);
  });

  /**
   * Hide a poster that fails to load. These are TheTVDB URLs from the backup and
   * some have rotted; one broken-image glyph in the strip undoes the whole
   * effect, and the neighbours simply widen to close the gap. Hidden rather than
   * removed — the node belongs to the @for block, and pulling it out from under
   * Angular breaks its own cleanup later.
   */
  hideBroken(event: Event): void {
    (event.target as HTMLImageElement).style.display = 'none';
  }

  initial(name: string): string {
    return name.trim().charAt(0).toUpperCase() || '?';
  }

  saveName(value: string): void {
    this.store.setProfileName(value);
    this.editing.set(false);
  }

  saveLogin(value: string): void {
    this.store.setProfileLogin(value);
    this.editingLogin.set(false);
  }

  // -------------------------------------------------------------------------
  // Public page
  // -------------------------------------------------------------------------
  /**
   * Both directions ask first. Publishing puts a page about you on the open
   * internet, and going private deletes it out from under links you may have
   * already sent — neither is something to do on a stray click, and neither
   * dialog is worth skipping just because the other exists.
   */
  askToggle(): void {
    if (!this.pub.isPublic() && !this.pub.canPublish()) {
      this.error.set(
        'Publishing needs the GitHub token cloud sync uses — connect it under Settings → Cloud sync first.',
      );
      return;
    }
    this.error.set(null);
    this.confirming.set(this.pub.isPublic() ? 'private' : 'publish');
  }

  /**
   * The list here is the contract: it names every field `packPublicProfile`
   * puts in the file, and the file carries nothing this text doesn't mention.
   * It also says plainly that a public gist is *listed*, not merely reachable —
   * "anyone with the link" would imply the page is only as findable as the link
   * you chose to send, which is not how GitHub publishes gists.
   */
  confirmMessage(): string {
    return this.confirming() === 'publish'
      ? 'A public gist is created on your GitHub account holding a snapshot of your name, ' +
          'username, picture, cover, member-since year, totals, favourites and top genres. ' +
          'Your watch history, screen time, settings and tokens stay private. Public gists are ' +
          'listed on your GitHub profile, so the page can be found there as well as through ' +
          'the link — and you can make it private again at any time.'
      : 'The public page and the gist behind it are deleted. Links you have already shared ' +
          'will stop working. Your library itself is untouched, and you can publish again later.';
  }

  async applyToggle(): Promise<void> {
    const action = this.confirming();
    this.confirming.set(null);
    if (!action) return;
    // Errors surface through pub.error() — the service records them before it
    // rethrows, so there is nothing to do here but not crash the click.
    if (action === 'publish') await this.pub.publish().catch(() => undefined);
    else await this.pub.unpublish().catch(() => undefined);
  }

  /** Re-publish now, for when a stale snapshot is about to be shared. */
  async republish(): Promise<void> {
    await this.pub.publish().catch(() => undefined);
  }

  async copyLink(): Promise<void> {
    const url = this.pub.url();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1600);
    } catch {
      // Clipboard blocked (insecure context, or denied) — the field is readonly
      // and selects itself on focus, so the link is still one gesture away.
      this.error.set('Could not copy — select the link and copy it manually.');
    }
  }

  /** "today" / "3 days ago" — enough to judge whether the page is stale. */
  publishedLabel(): string {
    const at = Date.parse(this.pub.publishedAt() ?? '');
    if (!Number.isFinite(at)) return 'recently';
    const days = Math.floor((Date.now() - at) / 86_400_000);
    if (days <= 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days} days ago`;
  }

  async onPick(event: Event): Promise<void> {
    await this.pick(event, this.busy, (f) => this.store.setProfileImage(f));
  }

  async onPickBanner(event: Event): Promise<void> {
    await this.pick(event, this.bannerBusy, (f) => this.store.setProfileBanner(f));
  }

  /** Shared plumbing for the two pickers: guard, run, surface the failure. */
  private async pick(
    event: Event,
    busy: WritableSignal<boolean>,
    apply: (file: File) => Promise<void>,
  ): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // let the same file be re-picked after an error
    if (!file) return;
    busy.set(true);
    this.error.set(null);
    try {
      await apply(file);
    } catch (e: any) {
      this.error.set(String(e?.message ?? e));
    } finally {
      busy.set(false);
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

  // Favourites and genres come from the store rather than being derived here:
  // the published snapshot shows the same three lists, and a second copy of the
  // arithmetic would eventually disagree with this page in public.
  readonly favShows = this.store.favoriteShows;
  readonly favMovies = this.store.favoriteMovies;
  readonly topGenres = this.store.topGenres;
}

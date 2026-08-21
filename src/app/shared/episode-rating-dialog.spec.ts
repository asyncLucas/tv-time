import { ComponentFixture, TestBed } from '@angular/core/testing';
import { EpisodeRatingDialog } from './episode-rating-dialog';

/**
 * The episode modal is reached two ways — opened to read about an episode, and
 * raised after ticking one off — and the difference between them is what it
 * offers, not what it is. These specs pin that difference down, plus the facts
 * row, which has to survive TMDB knowing only some of what it lists.
 */
describe('EpisodeRatingDialog', () => {
  let fixture: ComponentFixture<EpisodeRatingDialog>;
  let dialog: EpisodeRatingDialog;

  const text = (sel: string): string =>
    (fixture.nativeElement.querySelector(sel)?.textContent ?? '').replace(/\s+/g, ' ').trim();

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [EpisodeRatingDialog] }).compileComponents();
    fixture = TestBed.createComponent(EpisodeRatingDialog);
    dialog = fixture.componentInstance;
    fixture.componentRef.setInput('open', true);
    fixture.componentRef.setInput('code', 'S2·E4');
    fixture.componentRef.setInput('episodeTitle', 'The Spoils of War');
    fixture.componentRef.setInput('showName', 'Game of Thrones');
    fixture.detectChanges();
  });

  it('leads with the episode, not with the question', () => {
    expect(text('h3')).toBe('The Spoils of War');
    expect(text('.show')).toBe('Game of Thrones');
    // the question survives as the label on the thing it actually asks about
    expect(text('.rate-label')).toBe('How was it?');
  });

  it('falls back to the code when TMDB has no episode title', () => {
    fixture.componentRef.setInput('episodeTitle', null);
    fixture.detectChanges();
    expect(text('h3')).toBe('S2·E4');
  });

  describe('the facts row', () => {
    it('lists the air date, runtime and community score', () => {
      fixture.componentRef.setInput('airDate', '2017-08-06');
      fixture.componentRef.setInput('runtime', 59);
      fixture.componentRef.setInput('communityScore', 9.24);
      fixture.detectChanges();
      expect(dialog.facts()).toEqual([
        // the local 6th of August, not UTC midnight read in another timezone
        new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(2017, 7, 6)),
        '59 min',
        '★ 9.2',
      ]);
    });

    it('lists only what TMDB actually knows', () => {
      fixture.componentRef.setInput('runtime', 59);
      fixture.detectChanges();
      expect(dialog.facts()).toEqual(['59 min']);
    });

    it('is empty when TMDB knows none of it', () => {
      expect(dialog.facts()).toEqual([]);
    });

    /**
     * `Date.parse` accepts far more than TMDB ever sends — "sometime in 2017"
     * becomes the 1st of January in Chrome — so anything not shaped like an air
     * date is shown as-is rather than turned into a date nobody claimed.
     */
    it('shows a date it does not recognise verbatim, rather than inventing one', () => {
      fixture.componentRef.setInput('airDate', 'sometime in 2017');
      fixture.detectChanges();
      expect(dialog.facts()).toEqual(['sometime in 2017']);
    });

    /** A score of 0 means "nobody has rated it", not "rated zero". */
    it('leaves out a zero community score', () => {
      fixture.componentRef.setInput('communityScore', 0);
      fixture.detectChanges();
      expect(dialog.facts()).toEqual([]);
    });
  });

  describe('the watch toggle', () => {
    it('is absent on the path that just set it', () => {
      expect(fixture.nativeElement.querySelector('.seen')).toBeNull();
    });

    it('reads back the state and reports the click', () => {
      const toggles: number[] = [];
      dialog.watchedToggled.subscribe(() => toggles.push(1));

      fixture.componentRef.setInput('watched', false);
      fixture.detectChanges();
      expect(text('.seen')).toBe('Mark watched');

      fixture.nativeElement.querySelector('.seen').click();
      expect(toggles.length).toBe(1);

      // the page owns the state, so the label only turns once it answers
      fixture.componentRef.setInput('watched', true);
      fixture.detectChanges();
      expect(text('.seen')).toBe('✓ Watched');
    });
  });

  it('shows the synopsis only when there is one', () => {
    expect(fixture.nativeElement.querySelector('.synopsis')).toBeNull();
    fixture.componentRef.setInput('overview', 'Daenerys strikes back.');
    fixture.detectChanges();
    expect(text('.synopsis')).toBe('Daenerys strikes back.');
  });

  /**
   * Rating still commits on the tap and leaves the dialog up, so a score can be
   * seen, changed or cleared before it is dismissed.
   */
  it('commits a score without closing', () => {
    const rated: number[] = [];
    dialog.rated.subscribe((n) => rated.push(n));

    const pips = fixture.nativeElement.querySelectorAll('.pip');
    pips[7].click();
    fixture.detectChanges();

    expect(rated).toEqual([8]);
    expect(dialog.picked()).toBe(8);
    expect(fixture.nativeElement.querySelector('dialog').open).toBe(true);
  });
});

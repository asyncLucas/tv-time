import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LibraryStore } from '../core/library.store';
import { SaveMenu } from './save-menu';

/**
 * The save control is the one place a title's memberships are both read and
 * written, and it stands in front of a CRDT — so it is exercised against the
 * real `LibraryStore` rather than a stub. The store is inert in a test: its
 * IndexedDB persistence only starts when `whenReady()` is called, and nothing
 * here calls it, so each spec gets an empty in-memory doc.
 */
describe('SaveMenu', () => {
  const UUID = 'tmdb:show:1399';
  let fixture: ComponentFixture<SaveMenu>;
  let menu: SaveMenu;
  let store: LibraryStore;

  /** The panel's rows, as the labels a user would read. */
  function rowLabels(): string[] {
    return [...fixture.nativeElement.querySelectorAll('.lm-row')].map((r: Element) =>
      (r.textContent ?? '').trim(),
    );
  }

  /** Click the row whose name contains `text`. */
  function clickRow(text: string): void {
    const row = [...fixture.nativeElement.querySelectorAll('.lm-row')].find((r: Element) =>
      (r.textContent ?? '').includes(text),
    ) as HTMLButtonElement | undefined;
    if (!row) throw new Error(`no row matching "${text}" in [${rowLabels().join(', ')}]`);
    row.click();
  }

  /** The text of the control that opens the panel. */
  function triggerLabel(): string {
    return (fixture.nativeElement.querySelector('button')?.textContent ?? '').trim();
  }

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [SaveMenu] }).compileComponents();
    store = TestBed.inject(LibraryStore);

    fixture = TestBed.createComponent(SaveMenu);
    menu = fixture.componentInstance;
    fixture.componentRef.setInput('uuid', UUID);
    fixture.componentRef.setInput('title', 'Game of Thrones');
    fixture.componentRef.setInput('entityType', 'show');
    fixture.detectChanges();
  });

  /**
   * The label is the only thing a closed menu says about itself, so it has to
   * name every combination — being in the library is deliberately *not* one of
   * them, since a title with nothing saved should invite saving again.
   */
  describe('the label it reads back', () => {
    it('invites saving when the title is nowhere', () => {
      expect(triggerLabel()).toBe('+ Save ▾');
    });

    it('names the watchlist on its own', () => {
      fixture.componentRef.setInput('watchlist', true);
      fixture.detectChanges();
      expect(triggerLabel()).toBe('✓ Watchlist ▾');
    });

    it('counts lists, and pluralises them', () => {
      const first = store.createList('Sunday nights');
      store.addListItem(first, { uuid: UUID, title: 'Game of Thrones', entityType: 'show' });
      fixture.detectChanges();
      expect(triggerLabel()).toBe('✓ In 1 list ▾');

      const second = store.createList('Rewatch');
      store.addListItem(second, { uuid: UUID, title: 'Game of Thrones', entityType: 'show' });
      fixture.detectChanges();
      expect(triggerLabel()).toBe('✓ In 2 lists ▾');
    });

    it('adds the lists to the watchlist rather than choosing between them', () => {
      const id = store.createList('Sunday nights');
      store.addListItem(id, { uuid: UUID, title: 'Game of Thrones', entityType: 'show' });
      fixture.componentRef.setInput('watchlist', true);
      fixture.detectChanges();
      expect(triggerLabel()).toBe('✓ Watchlist +1 ▾');
    });

    it('ignores a list another title is on', () => {
      const id = store.createList('Films of the year');
      store.addListItem(id, { uuid: 'someone-else', title: 'Heat', entityType: 'movie' });
      fixture.detectChanges();
      expect(triggerLabel()).toBe('+ Save ▾');
    });
  });

  /**
   * The watchlist row is the one part each page owns: a film carries a flag, a
   * show carries a status that other statuses contradict. So the component
   * renders what it is given and reports the click — it never writes.
   */
  describe('the watchlist row', () => {
    it('is left out entirely when the state contradicts it', () => {
      fixture.componentRef.setInput('watchlist', null);
      menu.open.set(true);
      fixture.detectChanges();
      expect(rowLabels()).toEqual([]);
    });

    it('shows a checkmark only while the title is on the watchlist', () => {
      fixture.componentRef.setInput('watchlist', false);
      menu.open.set(true);
      fixture.detectChanges();
      expect(rowLabels()).toEqual(['Watchlist']);

      fixture.componentRef.setInput('watchlist', true);
      fixture.detectChanges();
      expect(rowLabels()).toEqual(['✓Watchlist']);
    });

    it('reports the click instead of writing anything itself', () => {
      const clicks: number[] = [];
      menu.watchlistToggled.subscribe(() => clicks.push(1));
      fixture.componentRef.setInput('watchlist', false);
      menu.open.set(true);
      fixture.detectChanges();

      clickRow('Watchlist');
      expect(clicks.length).toBe(1);
      // still false: the page owns this state and hasn't answered yet
      expect(menu.watchlist()).toBe(false);
    });
  });

  describe('custom lists', () => {
    beforeEach(() => {
      store.createList('Sunday nights');
      menu.open.set(true);
      fixture.detectChanges();
    });

    it('puts the title on a list, and takes it off again', async () => {
      const id = store.lists()[0].id;

      clickRow('Sunday nights');
      await fixture.whenStable();
      expect(store.isInList(id, UUID)).toBe(true);

      fixture.detectChanges();
      clickRow('Sunday nights');
      await fixture.whenStable();
      expect(store.isInList(id, UUID)).toBe(false);
    });

    it('creates a list from the draft name with the title already on it', async () => {
      const input: HTMLInputElement = fixture.nativeElement.querySelector('.lm-input');
      input.value = 'Rewatch';
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();

      fixture.nativeElement.querySelector('.lm-new').dispatchEvent(new Event('submit'));
      await fixture.whenStable();

      const created = store.lists().find((l) => l.name === 'Rewatch');
      expect(created).toBeTruthy();
      expect(store.isInList(created!.id, UUID)).toBe(true);
      // the field clears, so the next list starts from empty
      expect(menu.newListName()).toBe('');
    });

    it('refuses a blank name', async () => {
      fixture.nativeElement.querySelector('.lm-new').dispatchEvent(new Event('submit'));
      await fixture.whenStable();
      expect(store.lists().length).toBe(1);
    });

    /**
     * The hook that lets a page previewing a TMDB title add it to the library
     * before a list item points at it. It has to run *before* the write, or the
     * item would reference a uuid that resolves to nothing.
     */
    it('runs the page hook before it writes', async () => {
      const order: string[] = [];
      const id = store.lists()[0].id;
      fixture.componentRef.setInput('ensureSaveable', async () => {
        order.push(`hook, member=${store.isInList(id, UUID)}`);
      });
      fixture.detectChanges();

      clickRow('Sunday nights');
      await fixture.whenStable();

      expect(order).toEqual(['hook, member=false']);
      expect(store.isInList(id, UUID)).toBe(true);
    });
  });

  describe('the trigger', () => {
    it('opens and closes the panel', () => {
      const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
      expect(fixture.nativeElement.querySelector('.lm-panel')).toBeNull();

      button.click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.lm-panel')).not.toBeNull();

      button.click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.lm-panel')).toBeNull();
    });

    it('is a bare caret when it sits against an "Add to library" button', () => {
      fixture.componentRef.setInput('variant', 'caret');
      fixture.detectChanges();
      const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
      expect(button.textContent!.trim()).toBe('▾');
      expect(button.classList).toContain('split-caret');
      expect(button.getAttribute('aria-label')).toBe('Add to a list');
    });

    it('offers the danger row only when the page asks for one', () => {
      const removals: number[] = [];
      menu.removeRequested.subscribe(() => removals.push(1));
      menu.open.set(true);
      fixture.detectChanges();
      expect(rowLabels()).not.toContain('✕Remove from library');

      fixture.componentRef.setInput('removeLabel', 'Remove from library');
      fixture.detectChanges();
      clickRow('Remove from library');

      expect(removals.length).toBe(1);
      // and it closes the menu on its way out, since a dialog follows
      expect(menu.open()).toBe(false);
    });
  });
});

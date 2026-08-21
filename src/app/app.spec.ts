import { TestBed } from '@angular/core/testing';
import { App, isGuestRoute } from './app';

/**
 * The onboarding gate is bypassed on the two routes a visitor can reach without
 * a library. It is re-tested on every navigation, so what matters here is that
 * the exemption both *starts* on those URLs and *ends* when the visitor leaves
 * them — a stranger who follows the public profile page's link into the app has
 * to land on onboarding, not on an empty library.
 */
describe('isGuestRoute', () => {
  it('exempts the QR linking route, payload in the fragment and all', () => {
    expect(isGuestRoute('/link')).toBe(true);
    expect(isGuestRoute('/link/')).toBe(true);
    expect(isGuestRoute('/link#room=abc&key=def')).toBe(true);
  });

  it('exempts a published profile', () => {
    expect(isGuestRoute('/u/aa93bd1b0a5b9c9c62e0f5f4dfe3c2b1')).toBe(true);
    expect(isGuestRoute('/u/abc123/')).toBe(true);
  });

  it('reads a raw pathname carrying the deployed base href', () => {
    expect(isGuestRoute('/tv-time/u/abc123')).toBe(true);
    expect(isGuestRoute('/tv-time/link')).toBe(true);
  });

  it('stops exempting once the visitor navigates into the app itself', () => {
    expect(isGuestRoute('/')).toBe(false);
    expect(isGuestRoute('/shows')).toBe(false);
    expect(isGuestRoute('/profile')).toBe(false);
    expect(isGuestRoute('/tv-time/')).toBe(false);
  });

  it('does not exempt a deeper path that merely starts at a guest route', () => {
    expect(isGuestRoute('/u/abc123/settings')).toBe(false);
    expect(isGuestRoute('/u/')).toBe(false);
  });
});

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
    }).compileComponents();
  });

  it('should create the app', () => {
    const fixture = TestBed.createComponent(App);
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('should show the boot screen until the library has loaded', () => {
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('.boot')?.textContent).toContain('Restoring your library');
  });
});

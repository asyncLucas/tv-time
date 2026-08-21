/**
 * Open a title in Stremio, preferring the installed app.
 *
 * Stremio addresses everything by IMDb id through its bundled Cinemeta catalog,
 * so an id is all we need — no Stremio-specific lookup. `stremioUrl` builds the
 * Stremio Web link (`web.stremio.com`) that the badge keeps as its href, so
 * middle/modified clicks and copy-link always have a working browser target.
 * `openStremio` upgrades a plain click: it fires the `stremio://` protocol (an
 * `intent://` URL on Android, where Chrome falls back natively) and only opens
 * Stremio Web when the app never takes the foreground.
 */

const WEB_PREFIX = 'https://web.stremio.com/#/';

export function stremioUrl(kind: 'movie' | 'series', imdbId: string | null): string | null {
  if (!imdbId) return null;
  return `${WEB_PREFIX}detail/${kind}/${imdbId}/${imdbId}`;
}

export function openStremio(event: MouseEvent, webUrl: string): void {
  // A modified or non-primary click means "open the web link my way" — leave
  // the anchor's default behaviour alone.
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();

  const path = webUrl.slice(WEB_PREFIX.length); // detail/<kind>/<id>/<id>

  if (/android/i.test(navigator.userAgent)) {
    // Chrome on Android resolves intent:// itself: the app when installed,
    // the fallback URL otherwise. No timers needed.
    location.href =
      `intent://${path}#Intent;scheme=stremio;package=com.stremio.one;` +
      `S.browser_fallback_url=${encodeURIComponent(webUrl)};end`;
    return;
  }

  // Everywhere else there is no installed-app query, so fire the protocol and
  // watch the page: if the app took focus we get hidden/blurred and stay quiet,
  // otherwise fall back to Stremio Web.
  let appTookOver = false;
  const markLeft = () => (appTookOver = true);
  const onVisibility = () => {
    if (document.hidden) appTookOver = true;
  };
  window.addEventListener('pagehide', markLeft);
  window.addEventListener('blur', markLeft);
  document.addEventListener('visibilitychange', onVisibility);
  location.href = `stremio:///${path}`;
  setTimeout(() => {
    window.removeEventListener('pagehide', markLeft);
    window.removeEventListener('blur', markLeft);
    document.removeEventListener('visibilitychange', onVisibility);
    if (!appTookOver) window.open(webUrl, '_blank', 'noopener');
  }, 1500);
}

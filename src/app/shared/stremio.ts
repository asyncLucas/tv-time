/**
 * Build a link that opens a title in Stremio.
 *
 * Stremio addresses everything by IMDb id through its bundled Cinemeta catalog,
 * so an id is all we need — no Stremio-specific lookup. We link to Stremio Web
 * (`web.stremio.com`) rather than the `stremio://` protocol so the link works in
 * any browser; if the viewer has the desktop/mobile app, Stremio Web still hands
 * off to it. Returns null when we have no IMDb id to point at.
 */
export function stremioUrl(kind: 'movie' | 'series', imdbId: string | null): string | null {
  if (!imdbId) return null;
  return `https://web.stremio.com/#/detail/${kind}/${imdbId}/${imdbId}`;
}

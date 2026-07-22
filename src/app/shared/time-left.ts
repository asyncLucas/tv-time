import { Pipe, PipeTransform } from '@angular/core';

/**
 * A day-granular countdown to an episode air date, e.g. "Today", "Tomorrow",
 * "in 3 days", "in 2 weeks". TMDB gives `air_date` with no clock time, so whole
 * days compared on the local calendar is the finest we can honestly show.
 *
 * Pure (the default): Angular re-runs it only when the `airDate` string changes,
 * not on every change-detection cycle — cheaper than a template method. The
 * trade-off is it won't tick over on its own at local midnight; a card left open
 * across midnight refreshes on the next data change (a poll, an episode ticked),
 * which is well within tolerance for an "airing soon" hint.
 */
@Pipe({ name: 'timeLeft' })
export class TimeLeftPipe implements PipeTransform {
  transform(airDate: string | null | undefined): string {
    if (!airDate) return '';
    const [y, m, d] = airDate.split('-').map(Number);
    if (!y || !m || !d) return airDate; // unexpected format — show it verbatim
    const air = new Date(y, m - 1, d);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Math.round((air.getTime() - today.getTime()) / 86_400_000);
    if (days < 0) return 'Aired';
    if (days === 0) return 'Today';
    if (days === 1) return 'Tomorrow';
    if (days < 14) return `in ${days} days`;
    return `in ${Math.round(days / 7)} weeks`;
  }
}

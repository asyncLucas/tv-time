import { Pipe, PipeTransform } from '@angular/core';

/**
 * The year from an ISO-ish date string ("2024-05-01" → "2024"), for the release
 * year shown on cards and detail headers. Relies on the leading `YYYY-` layout
 * TMDB and the backup both use rather than parsing a Date, so an empty or
 * partial value degrades to '' instead of "NaN"/"Invalid Date".
 */
@Pipe({ name: 'year' })
export class YearPipe implements PipeTransform {
  transform(date: string | null | undefined): string {
    return date?.slice(0, 4) ?? '';
  }
}

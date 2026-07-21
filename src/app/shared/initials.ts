import { Pipe, PipeTransform } from '@angular/core';

/**
 * Leading articles stripped before deriving initials, so "The Office" reads as
 * "OF" rather than "TO". Covers English and Portuguese — TV Time backups from
 * pt-BR accounts carry list and title names in either language.
 */
const LEADING_ARTICLE = /^(the|a|an|o|as|os|um|uma)\s+/i;

/**
 * Up to two initials for a title, used by poster and list-item placeholders.
 * Returns '' for an empty/blank title — callers render the tile regardless, so
 * an empty label is preferable to a stand-in character.
 */
export function initialsOf(title: string | null | undefined): string {
  return (title ?? '')
    .trim()
    .replace(LEADING_ARTICLE, '')
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0] ?? '')
    .join('')
    .toUpperCase();
}

/**
 * Template form of `initialsOf`. Pure, so placeholder initials are computed once
 * per distinct title instead of on every change-detection pass — worthwhile in
 * the list/search grids where it renders once per row.
 */
@Pipe({ name: 'initials' })
export class InitialsPipe implements PipeTransform {
  transform(title: string | null | undefined): string {
    return initialsOf(title);
  }
}

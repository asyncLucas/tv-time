import { initialsOf } from './initials';

describe('initialsOf', () => {
  it('takes the first letter of up to two words', () => {
    expect(initialsOf('Breaking Bad')).toBe('BB');
    expect(initialsOf('The Marvelous Mrs. Maisel')).toBe('MM');
  });

  it('strips a leading article in English or Portuguese', () => {
    expect(initialsOf('The Office')).toBe('O');
    expect(initialsOf('As Branquelas')).toBe('B');
    expect(initialsOf('O Auto da Compadecida')).toBe('AD');
  });

  it('yields one letter for a single-word title', () => {
    expect(initialsOf('Severance')).toBe('S');
  });

  it('only strips an article followed by a space, not a word starting with one', () => {
    expect(initialsOf('Alone')).toBe('A');
    expect(initialsOf('Ozark')).toBe('O');
  });

  it('returns empty for blank or missing titles rather than throwing', () => {
    expect(initialsOf('')).toBe('');
    expect(initialsOf('   ')).toBe('');
    expect(initialsOf(null)).toBe('');
    expect(initialsOf(undefined)).toBe('');
  });
});

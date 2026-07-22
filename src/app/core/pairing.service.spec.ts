import { decodeLink, randomToken } from './pairing.service';

/** Build a link code the way the QR encoder does, so the tests use real input. */
function code(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const VALID = { v: 1 as const, i: 'room-id-1234', k: 'a-secret-key-here-22ch' };

describe('decodeLink', () => {
  it('reads a scanned URL, taking the payload from the fragment', () => {
    expect(decodeLink(`https://tv.example/link#${code(VALID)}`)).toEqual(VALID);
  });

  it('reads a bare code, for the paste-it-by-hand path', () => {
    expect(decodeLink(code(VALID))).toEqual(VALID);
  });

  it('tolerates surrounding whitespace from a sloppy copy/paste', () => {
    expect(decodeLink(`  ${code(VALID)}\n`)).toEqual(VALID);
  });

  it('carries a custom signaling server when the fleet uses one', () => {
    const withSignaling = { ...VALID, s: 'wss://signal.example' };
    expect(decodeLink(code(withSignaling))).toEqual(withSignaling);
  });

  it('round-trips every base64url padding length', () => {
    // The encoder strips '=' padding; a decoder that restores it wrongly fails
    // on some lengths and not others, so cover all of them.
    for (let n = 1; n <= 8; n++) {
      const payload = { ...VALID, i: 'x'.repeat(n) };
      expect(decodeLink(code(payload))).toEqual(payload);
    }
  });

  it('rejects junk rather than half-reading it', () => {
    expect(decodeLink('')).toBeNull();
    expect(decodeLink('   ')).toBeNull();
    expect(decodeLink('not-a-code')).toBeNull();
    expect(decodeLink('https://tv.example/link#!!!!')).toBeNull();
  });

  it('rejects a payload missing the room or the key', () => {
    expect(decodeLink(code({ v: 1, i: 'only-an-id' }))).toBeNull();
    expect(decodeLink(code({ v: 1, k: 'only-a-key' }))).toBeNull();
  });

  it('rejects a version it does not understand', () => {
    expect(decodeLink(code({ ...VALID, v: 2 }))).toBeNull();
  });
});

describe('randomToken', () => {
  it('is URL-safe, so it survives being put in a link', () => {
    for (let i = 0; i < 20; i++) expect(randomToken(16)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('does not repeat itself', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomToken(16)));
    expect(seen.size).toBe(50);
  });
});

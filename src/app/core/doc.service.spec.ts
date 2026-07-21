import { DocService } from './doc.service';

/**
 * Import is the app's untrusted-input boundary: the file may be hand-edited or
 * come from someone else, and whatever lands in the CRDT replicates to every
 * other device. These cover the shape-checking that guards it.
 */
describe('DocService import/export', () => {
  let docs: DocService;

  beforeEach(() => {
    docs = new DocService();
  });

  const file = (body: Record<string, unknown>) =>
    JSON.stringify({ kind: 'tvtime-revival-state', ...body });

  it('rejects a file without the state-file discriminator', () => {
    expect(() => docs.importJson(JSON.stringify({ showState: {} }))).toThrowError(
      /Not a TV Time Revival state file/,
    );
  });

  it('merges well-formed entries', () => {
    docs.importJson(file({ showState: { 'uuid-1': { status: 'watching', favorite: true } } }));
    expect(docs.showState.get('uuid-1')).toEqual(
      jasmine.objectContaining({ status: 'watching', favorite: true }),
    );
  });

  it('skips sections that are not objects', () => {
    docs.importJson(file({ showState: ['not', 'a', 'map'], movieState: 'nope' }));
    expect(docs.showState.size).toBe(0);
    expect(docs.movieState.size).toBe(0);
  });

  it('skips scalar entries in id-keyed sections', () => {
    docs.importJson(file({ showState: { good: { status: 'none' }, bad: 'scalar' } }));
    expect(docs.showState.has('good')).toBeTrue();
    expect(docs.showState.has('bad')).toBeFalse();
  });

  it('allows scalars in the profile, which stores them directly', () => {
    docs.importJson(file({ profile: { name: 'Ada' } }));
    expect(docs.profile.get('name')).toBe('Ada');
  });

  it('round-trips through export without carrying device-local secrets', () => {
    docs.profile.set('name', 'Ada');
    const exported = JSON.parse(docs.exportJson());
    expect(exported.kind).toBe('tvtime-revival-state');
    expect(exported.profile.name).toBe('Ada');
    expect(exported.settings).toBeUndefined();
  });
});

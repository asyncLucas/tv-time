import { TestBed } from '@angular/core/testing';
import { SyncService } from './sync.service';

/**
 * `whenConnected` is what the linking screen's "Peer-to-peer sync connected"
 * tick is built on, so its two answers have to mean what they say: a peer is
 * really there, or none turned up in time. Being alone in a reachable room is
 * the case that used to read as success.
 */
describe('waiting for a peer', () => {
  let sync: SyncService;

  beforeEach(() => {
    sync = TestBed.inject(SyncService);
  });

  it('resolves straight away when a peer is already there', async () => {
    sync.peers.set(1);
    await expectAsync(sync.whenConnected(50)).toBeResolvedTo(true);
  });

  it('resolves once a peer turns up mid-wait', async () => {
    const waited = sync.whenConnected(2_000);
    setTimeout(() => sync.peers.set(1), 300);
    await expectAsync(waited).toBeResolvedTo(true);
  });

  it('gives up when the room stays empty', async () => {
    await expectAsync(sync.whenConnected(400)).toBeResolvedTo(false);
  });

  it('an empty room is not a connection, however reachable it is', async () => {
    sync.status.set('connecting');
    sync.peers.set(0);
    await expectAsync(sync.whenConnected(400)).toBeResolvedTo(false);
  });
});

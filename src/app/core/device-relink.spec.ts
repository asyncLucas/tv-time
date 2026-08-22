import { TestBed } from '@angular/core/testing';
import * as Y from 'yjs';
import { DeviceService } from './device.service';
import { DocService } from './doc.service';
import { GistSyncService } from './gist-sync.service';
import { LocalConfigService } from './local-config.service';
import { SyncService } from './sync.service';

/**
 * Re-linking a device that was signed out before.
 *
 * The failure this guards against had no visible seam: pairing reported "you're
 * all set", and moments later the freshly linked device dropped its gist token,
 * disconnected P2P and persisted `signedOut` — because the granting device's
 * doc still carried the old tombstone, and merging it back in tripped the
 * revocation watcher. Every symptom pointed at the handshake, which was fine.
 *
 * So the specs below are about ordering, not about pairing: a revocation that
 * predates the link is spent, whichever way round the two docs merge.
 */
describe('re-linking a device that was signed out', () => {
  let devices: DeviceService;
  let docs: DocService;
  let config: LocalConfigService;
  let forgotten: boolean;

  /** The id this device adopts — fixed so the fleet doc can tombstone it. */
  const ID = 'device-under-test';

  /** A stand-in fleet doc: what the granting device would sync over. */
  let fleet: Y.Doc;

  /**
   * In-memory stand-in for the device-local store. The real one is a single
   * IndexedDB shared by every spec in the run, which would let one case's
   * `linkedAt` decide another's verdict — and this suite is entirely about
   * which timestamp wins.
   */
  class FakeConfig {
    private store: Record<string, any> = {};
    init(): Promise<void> {
      return Promise.resolve();
    }
    get<T>(key: string): T | undefined {
      return this.store[key];
    }
    async set(key: string, value: any): Promise<void> {
      this.store[key] = value;
    }
    async delete(key: string): Promise<void> {
      delete this.store[key];
    }
  }

  /** Merge the fleet's state into this device's doc, as gist/P2P sync would. */
  function mergeFleet(): void {
    Y.applyUpdate(docs.doc, Y.encodeStateAsUpdate(fleet));
  }

  /** Yjs observers are synchronous; signOutSelf's own writes are not. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }

  beforeEach(async () => {
    forgotten = false;
    fleet = new Y.Doc();

    TestBed.configureTestingModule({
      providers: [
        // Both sync channels are inert here: this is about who decides the
        // device is revoked, not about how the decision travels.
        { provide: SyncService, useValue: { setPresence: () => {}, disconnect: () => {}, autoStart: () => {}, presences: () => [] } },
        {
          provide: GistSyncService,
          useValue: { forget: () => (forgotten = true), autoStart: () => {} },
        },
        { provide: LocalConfigService, useClass: FakeConfig },
      ],
    });

    config = TestBed.inject(LocalConfigService);
    await config.init();
    await config.set('deviceId', ID);

    docs = TestBed.inject(DocService);
    devices = TestBed.inject(DeviceService);
  });

  it('stays linked when the granting doc still holds its old tombstone', async () => {
    // The fleet signed this device out at some point in the past.
    fleet.getMap<string>('revokedDevices').set(ID, '2026-01-01T00:00:00.000Z');

    await devices.init();
    // Pairing hands over credentials stamped by the granting device's clock.
    await devices.reactivate('2026-06-01T00:00:00.000Z');

    // ...and then the granting device's doc arrives, tombstone and all.
    mergeFleet();
    await settle();

    expect(devices.signedOut()).toBe(false);
    expect(forgotten).toBe(false);
    expect(config.get('signedOut')).toBeUndefined();
  });

  it('drops the spent tombstone so the fleet stops carrying it', async () => {
    fleet.getMap<string>('revokedDevices').set(ID, '2026-01-01T00:00:00.000Z');

    await devices.init();
    await devices.reactivate('2026-06-01T00:00:00.000Z');
    mergeFleet();
    await settle();

    expect(docs.revokedDevices.has(ID)).toBe(false);
  });

  it('still signs itself out when the revocation came after the link', async () => {
    await devices.init();
    await devices.reactivate('2026-06-01T00:00:00.000Z');

    // Someone signed this device out from another device, after it was linked.
    fleet.getMap<string>('revokedDevices').set(ID, '2026-07-01T00:00:00.000Z');
    mergeFleet();
    await settle();

    expect(devices.signedOut()).toBe(true);
    expect(forgotten).toBe(true);
  });

  it('honours a revocation on a device that has never been linked', async () => {
    fleet.getMap<string>('revokedDevices').set(ID, '2026-01-01T00:00:00.000Z');
    mergeFleet();

    await devices.init();
    await settle();

    expect(devices.signedOut()).toBe(true);
  });

  it('authorize() clears the tombstone in the doc that actually holds it', () => {
    docs.revokedDevices.set('some-other-device', '2026-01-01T00:00:00.000Z');
    devices.authorize('some-other-device');
    expect(docs.revokedDevices.has('some-other-device')).toBe(false);
  });
});

# TV Time Revival

A decentralized, local-first PWA that resurrects your **TV Time** library after the
service shut down. Your 288 shows, 565 movies, watch history, favorites and lists —
recovered from an on-device backup and turned into a living tracker you own outright.

**No database. No server. No account.** Your data lives in your browser and syncs
peer-to-peer across your own devices, end-to-end encrypted.

---

## Why this exists

TV Time's backend was decommissioned. The only surviving copy of the library was the
app's on-device cache, pulled via `adb backup`. This project treats that snapshot as
the source of truth and rebuilds a full tracker on top of it — one that never depends
on anyone else's servers staying alive again.

## Architecture

```
Angular 20 PWA (static, service-worker cached, installable)
        │
   LibraryStore (Angular signals)
        │  merges …
        ├── Catalog  ── public/seed.json  (immutable, identical on every device, never synced)
        └── User state ── Yjs CRDT ── y-indexeddb (local persistence)
                                   └── y-webrtc  (E2E-encrypted P2P sync, optional)
        │
   TMDB service ── Cache-API content-addressed cache (posters, seasons, episodes)
```

**The key split:** the 600 KB catalog is baked into the app and loaded identically
everywhere, so it never travels over the wire. Only *mutable, mergeable facts* — what
you've watched, your watchlist, ratings, favorites, list edits — live in the Yjs
document. That doc is tiny, conflict-free (CRDT), persisted locally in IndexedDB, and
the only thing that syncs between devices.

**Sync** is `y-webrtc`: your devices discover each other through public signaling
servers, then exchange CRDT updates directly. The room is encrypted with a passphrase
only your devices know, so signaling servers only ever relay opaque blobs. A JSON
**export/import** is the always-works floor beneath sync.

**Metadata** comes from TMDB at runtime, resolved by the `tvdb_id`/`imdb_id` recovered
in the seed (exact lookups, not fuzzy title search). Responses are cached by URL via
the Cache API, so the id maps to one entry, works offline once fetched, and never
re-hits the network within its TTL.

## Data pipeline (`tools/build-seed.py`)

Turns the raw backup into `public/seed.json`. The clever bit: `followed_shows.csv`
ships with **no ids**, but the app's cached API responses (`diocache-json/`) carry each
show's TheTVDB id, joinable by `uuid` — so every one of the 288 shows recovers a stable
id for TMDB enrichment, plus any cached TheTVDB poster URLs.

```bash
# Regenerate the seed from the backup (default path: ~/tvtime-backup/account)
TVTIME_BACKUP=/path/to/tvtime-backup/account npm run seed
```

Produces: 288 shows (all with TVDB ids + posters), 565 movies, 452 watched-movie
records, 43 cached watched episodes, favorites, and 3 custom lists.

> Episode-level history is only the cached subset (the backend died before a full sync).
> Shows and movies are complete at the library level; use **"mark watched up to here"**
> on a show to backfill episode progress.

## Run it

```bash
npm install
npm run seed        # generate public/seed.json from the backup (once)
npm start           # dev server at http://localhost:4200
```

First launch imports the seed into the CRDT and persists it to IndexedDB. Reloads and
offline use are instant thereafter.

### Enable posters & "what's airing"
Settings → paste a free [TMDB API key](https://www.themoviedb.org/settings/api). Even
without one, shows display recovered TheTVDB artwork.

### Sync across your devices
Settings → Decentralized sync → pick a room name + passphrase, open the same pair on
another device. Offline edits merge automatically on reconnect.

## Build & deploy (static — host anywhere)

```bash
npm run build                          # → dist/tvtime-revival/browser
# GitHub Pages / subpath hosting:
npm run build -- --base-href /tvtime-revival/
```

Deploy the `browser/` folder to GitHub Pages, Netlify, Cloudflare Pages, or any static
host. There is nothing else to run.

## Project layout

```
tools/build-seed.py            Backup → seed.json pipeline
public/seed.json               The immutable catalog (generated)
src/app/core/
  models.ts                    Domain + view models
  seed.service.ts              Loads the catalog, id lookups
  doc.service.ts               Owns the Yjs doc, IndexedDB, bootstrap, export/import
  library.store.ts             Signal facade: catalog x user state -> view models + mutations
  tmdb.service.ts              TMDB resolution + Cache-API caching
  sync.service.ts              y-webrtc E2E-encrypted P2P sync
src/app/features/              home · shows · show-detail · movies · lists · profile · settings
src/app/shared/poster.ts       Lazy, self-healing poster (TMDB -> cached -> gradient)
```

---

Built from `asyncLucas`'s TV Time backup. Your history, kept alive — decentralized and yours.

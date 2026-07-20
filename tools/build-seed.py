#!/usr/bin/env python3
"""Phase 0 — TV Time backup -> normalized seed.json.

Reads the on-device backup (dead-backend snapshot, ~22 Jan 2026) and produces a
single, normalized seed the PWA imports into its CRDT document on first launch.

Key recovery trick: followed_shows.csv ships with NO ids, but the diocache-json
records (the app's cached API responses) carry each show's TheTVDB id in `id`,
joinable by `uuid`. That gives every followed show a stable TVDB id for TMDB
resolution at runtime, plus any TheTVDB poster URLs the cache happened to hold.

Pure stdlib — no external deps. Run: python3 tools/build-seed.py
"""
import csv, json, glob, os, sys, hashlib
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
BACKUP = os.environ.get("TVTIME_BACKUP", os.path.expanduser("~/tvtime-backup/account"))
EXPORT = os.path.join(BACKUP, "export")
DIOCACHE = os.path.join(BACKUP, "diocache-json")
# Personal data is NOT bundled with the app (that would ship one user's library
# to every visitor). Generate it to a git-ignored local file and import it once
# via the app's onboarding screen; it then persists in the browser.
OUT = os.path.join(PROJECT, "seed.local.json")


def rows(name):
    path = os.path.join(EXPORT, name)
    if not os.path.exists(path):
        print(f"  ! missing {name}", file=sys.stderr)
        return []
    with open(path, newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(fh))


def clean(v):
    v = (v or "").strip()
    return v or None


def iso(v):
    """Normalize timestamps to ISO-8601 UTC 'Z' form; pass through if unknown."""
    v = clean(v)
    if not v:
        return None
    for fmt in ("%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S.%f", "%Y-%m-%d"):
        try:
            dt = datetime.strptime(v, fmt).replace(tzinfo=timezone.utc)
            return dt.strftime("%Y-%m-%dT%H:%M:%SZ")
        except ValueError:
            continue
    return v


def genres(v):
    v = clean(v)
    return [g for g in v.split("|")] if v else []


# ---------------------------------------------------------------------------
# 1. Mine diocache for show records: uuid -> {tvdb id, flags, poster urls}
# ---------------------------------------------------------------------------
def walk(o):
    if isinstance(o, dict):
        yield o
        for v in o.values():
            yield from walk(v)
    elif isinstance(o, list):
        for v in o:
            yield from walk(v)


def best_poster(images):
    """Pick the first poster URL from a diocache `images` array (TheTVDB CDN)."""
    if not isinstance(images, list):
        return None
    posters = [i for i in images if isinstance(i, dict) and i.get("type") == "poster" and i.get("url")]
    pick = (posters or [i for i in images if isinstance(i, dict) and i.get("url")])
    if not pick:
        return None
    img = pick[0]
    versions = img.get("versions") or {}
    return versions.get("medium") or versions.get("small") or img.get("url")


def build_show_index():
    idx = {}
    for fn in glob.glob(os.path.join(DIOCACHE, "*.json")):
        try:
            data = json.load(open(fn, encoding="utf-8"))
        except (ValueError, OSError):
            continue
        for obj in walk(data):
            # a series record (not an episode) that carries a uuid
            if (
                "name" in obj and "id" in obj and "uuid" in obj
                and "season_number" not in obj and "number" not in obj
            ):
                u = obj["uuid"]
                prev = idx.get(u, {})
                # prefer the richest record we see for a given uuid
                poster = best_poster(obj.get("images")) or best_poster(obj.get("all_images")) or prev.get("poster")
                idx[u] = {
                    "tvdb_id": str(obj.get("id")) if obj.get("id") is not None else prev.get("tvdb_id"),
                    "is_ended": obj.get("is_ended", prev.get("is_ended")),
                    "day_of_week": obj.get("day_of_week", prev.get("day_of_week")),
                    "network": obj.get("network") or prev.get("network"),
                    "country": obj.get("country") or prev.get("country"),
                    "hashtag": obj.get("hashtag") or prev.get("hashtag"),
                    "overview": obj.get("overview") or prev.get("overview"),
                    "poster": poster,
                }
    return idx


# ---------------------------------------------------------------------------
# 2. Assemble collections
# ---------------------------------------------------------------------------
def build():
    show_idx = build_show_index()

    fav_show_uuids = {r["uuid"] for r in rows("favorite_shows.csv")}
    fav_movie_uuids = {r["uuid"] for r in rows("favorite_movies.csv")}

    shows = []
    for r in rows("followed_shows.csv"):
        enr = show_idx.get(r["uuid"], {})
        shows.append({
            "uuid": r["uuid"],
            "name": clean(r["name"]),
            "tvdbId": enr.get("tvdb_id"),
            "genres": genres(r["genres"]),
            "firstReleaseDate": clean(r["first_release_date"]),
            "overview": clean(r["overview"]) or enr.get("overview"),
            "followedAt": iso(r["followed_at"]),
            "showWatchedAt": iso(r["watched_at"]),
            "isEnded": enr.get("is_ended"),
            "dayOfWeek": enr.get("day_of_week"),
            "network": enr.get("network"),
            "country": enr.get("country"),
            "hashtag": enr.get("hashtag"),
            "cachedPoster": enr.get("poster"),
            "favorite": r["uuid"] in fav_show_uuids,
        })

    movies = []
    for r in rows("tracked_movies.csv"):
        movies.append({
            "uuid": r["uuid"],
            "name": clean(r["name"]),
            "imdbId": clean(r["imdb_id"]),
            "tvdbId": clean(r["tvdb_id"]),
            "genres": genres(r["genres"]),
            "firstReleaseDate": clean(r["first_release_date"]),
            "overview": clean(r["overview"]),
            "followedAt": iso(r["followed_at"]),
            "watchedAt": iso(r["watched_at"]),
            "favorite": r["uuid"] in fav_movie_uuids,
        })
    movie_by_uuid = {m["uuid"]: m for m in movies}

    # Watched-movie log — join to library by uuid to recover title + ids.
    watched_movies = []
    for r in rows("watched_movie_records.csv"):
        m = movie_by_uuid.get(r["uuid"], {})
        watched_movies.append({
            "uuid": r["uuid"],
            "name": m.get("name"),
            "imdbId": m.get("imdbId"),
            "watchedAt": iso(r["watched_at"]),
            "runtimeSec": int(r["runtime_sec"]) if clean(r.get("runtime_sec")) else None,
        })

    # Cached watched episodes (only 43 — the rest of episode history died with the backend).
    watched_episodes = []
    for r in rows("watched_episodes.csv"):
        watched_episodes.append({
            "show": clean(r["show"]),
            "showId": clean(r["show_id"]),       # TheTVDB series id
            "season": int(r["season"]) if clean(r["season"]) else None,
            "number": int(r["number"]) if clean(r["number"]) else None,
            "episodeTitle": clean(r["episode"]),
            "episodeId": clean(r["episode_id"]),
            "seen": clean(r["seen"]) == "True",
            "seenDate": iso(r["seen_date"]),
            "nbTimesWatched": int(r["nb_times_watched"]) if clean(r["nb_times_watched"]) else 1,
            "network": clean(r["network"]),
        })

    # Custom lists + their items (items reference titles, not uuids).
    lists = []
    items_by_list = {}
    for r in rows("custom_list_items.csv"):
        items_by_list.setdefault(r["list"], []).append({
            "title": clean(r["item"]),
            "entityType": clean(r["entity_type"]),
            "uuid": clean(r["uuid"]),
        })
    for r in rows("custom_lists.csv"):
        lists.append({
            "id": r["id"],
            "name": clean(r["name"]),
            "description": clean(r["description"]),
            "isPublic": clean(r["is_public"]) == "True",
            "type": clean(r["type"]),
            "createdAt": iso(r["created_at"]),
            "items": items_by_list.get(r["name"], []),
        })

    profile_raw = json.load(open(os.path.join(EXPORT, "profile.json"), encoding="utf-8"))
    acct = profile_raw.get("account", {})
    profile = {
        "id": acct.get("id"),
        "login": acct.get("login"),
        "name": acct.get("name"),
        "image": acct.get("image"),
        "timezone": acct.get("timezone"),
        "lang": acct.get("lang"),
        "createdAt": iso(acct.get("creation_date")),
        "favoriteGenres": profile_raw.get("settings", {}).get("favorite_genres", []),
        "stats": acct.get("stats", {}),
    }

    seed = {
        "meta": {
            "source": "TV Time on-device backup (adb) — backend shut down",
            "syncedApprox": "2026-01-22",
            "backedUp": "2026-07-20",
            "schema": 1,
            "note": "Episode-level history is only the cached subset (backend dead). "
                    "Shows/movies are complete at library level; TVDB ids recovered "
                    "from diocache enable TMDB enrichment at runtime.",
        },
        "profile": profile,
        "shows": shows,
        "movies": movies,
        "watchedMovies": watched_movies,
        "watchedEpisodes": watched_episodes,
        "customLists": lists,
    }
    return seed


def main():
    seed = build()
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    payload = json.dumps(seed, ensure_ascii=False, indent=2)
    with open(OUT, "w", encoding="utf-8") as fh:
        fh.write(payload)
    digest = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]

    s = seed
    shows_with_tvdb = sum(1 for x in s["shows"] if x["tvdbId"])
    shows_with_poster = sum(1 for x in s["shows"] if x["cachedPoster"])
    print(f"seed.json written -> {os.path.relpath(OUT, PROJECT)}  ({len(payload)//1024} KB, sha {digest})")
    print(f"  profile      : {s['profile']['login']} (id {s['profile']['id']})")
    print(f"  shows        : {len(s['shows'])}  (tvdb id: {shows_with_tvdb}, cached poster: {shows_with_poster})")
    print(f"  movies       : {len(s['movies'])}")
    print(f"  watchedMovies: {len(s['watchedMovies'])}")
    print(f"  watchedEps   : {len(s['watchedEpisodes'])}")
    print(f"  customLists  : {len(s['customLists'])}")


if __name__ == "__main__":
    main()

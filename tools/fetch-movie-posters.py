#!/usr/bin/env python3
"""Bake film artwork into the shipped catalog.

TV Time backups carry a cached TheTVDB poster for every *show* and none for any
*movie*, so a device with no TMDB key renders the whole movie library as initial
tiles. The runtime poster cache fixes that for anyone who has a key — but only
after they've browsed with one, and never for a first-run visitor.

This closes the gap once, offline: resolve each film's IMDb id through TMDB and
write the poster URL into `cachedPoster`, exactly where the app already looks.
Artwork is public metadata (the same URLs the app fetches at runtime), so this
adds nothing personal to the catalog it ships.

Run it whenever build-seed.py regenerates the catalog:

    TMDB_API_KEY=<v3 key or v4 read token> python3 tools/fetch-movie-posters.py

Idempotent and resumable: films that already have a poster are skipped, so a run
interrupted halfway just picks up where it left off. Pass --force to re-resolve.

Pure stdlib — no external deps.
"""
import json, os, sys, time, urllib.error, urllib.parse, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
# Both files hold the same films: the public catalog that ships with the app and
# the git-ignored personal seed. Whichever exists gets enriched.
TARGETS = [
    os.path.join(PROJECT, "public", "catalog.json"),
    os.path.join(PROJECT, "seed.local.json"),
]
API = "https://api.themoviedb.org/3"
IMG = "https://image.tmdb.org/t/p/w342"
# TMDB's published ceiling is ~50 req/s; this is far under it and still finishes
# 565 films in about a minute.
PAUSE_S = 0.06


def auth(key):
    """v3 keys go in the query string, v4 read tokens in an Authorization header."""
    if key.count(".") == 2 and key.startswith("ey"):
        return {}, {"Authorization": f"Bearer {key}"}
    return {"api_key": key}, {}


def find_poster(imdb_id, key):
    """The TMDB poster path for an IMDb id, or None if TMDB doesn't have one."""
    params, headers = auth(key)
    params["external_source"] = "imdb_id"
    url = f"{API}/find/{urllib.parse.quote(imdb_id)}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as res:
        data = json.load(res)
    for hit in data.get("movie_results") or []:
        if hit.get("poster_path"):
            return hit["poster_path"]
    return None


def main():
    key = os.environ.get("TMDB_API_KEY", "").strip()
    if not key:
        sys.exit("TMDB_API_KEY is not set. Get one at https://www.themoviedb.org/settings/api")
    force = "--force" in sys.argv

    # One lookup per IMDb id, shared across both files — they overlap entirely.
    posters = {}
    failed = []

    for path in TARGETS:
        if not os.path.exists(path):
            print(f"skip (absent): {os.path.relpath(path, PROJECT)}")
            continue
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)

        movies = data.get("movies") or []
        todo = [
            m for m in movies
            if m.get("imdbId") and (force or not m.get("cachedPoster"))
        ]
        print(f"{os.path.relpath(path, PROJECT)}: {len(todo)} of {len(movies)} films to resolve")

        for i, movie in enumerate(todo, 1):
            imdb = movie["imdbId"]
            if imdb not in posters:
                try:
                    posters[imdb] = find_poster(imdb, key)
                except urllib.error.HTTPError as err:
                    if err.code in (401, 403):
                        sys.exit(f"TMDB rejected the credential ({err.code}). Check TMDB_API_KEY.")
                    posters[imdb] = None
                    failed.append((movie.get("name"), f"HTTP {err.code}"))
                except Exception as err:  # network hiccup — note it and move on
                    posters[imdb] = None
                    failed.append((movie.get("name"), str(err)))
                time.sleep(PAUSE_S)
            if posters[imdb]:
                movie["cachedPoster"] = IMG + posters[imdb]
            if i % 50 == 0 or i == len(todo):
                print(f"  {i}/{len(todo)}")

        with open(path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=False, indent=2)
        have = sum(1 for m in movies if m.get("cachedPoster"))
        print(f"  written — {have}/{len(movies)} films now have a cover")

    if failed:
        print(f"\n{len(failed)} unresolved (re-run to retry):")
        for name, why in failed[:20]:
            print(f"  {name}: {why}")


if __name__ == "__main__":
    main()

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parsePlexRatingKey, readItunesDb } from "../src/itunesdbReader.js";

describe("parsePlexRatingKey", () => {
  test("extracts the ratingKey from a PLEXID comment", () => {
    expect(parsePlexRatingKey("PLEXID:55123")).toBe("55123");
    expect(parsePlexRatingKey("  PLEXID:abc  ")).toBe("abc");
  });
  test("returns undefined for non-Plex or empty comments", () => {
    expect(parsePlexRatingKey(undefined)).toBeUndefined();
    expect(parsePlexRatingKey("just a comment")).toBeUndefined();
    expect(parsePlexRatingKey("")).toBeUndefined();
  });
});

// Structural diff against the real iTunes-written DB — the correctness oracle.
// The file is local-only and gitignored (it holds the user's real library metadata),
// so this test SKIPS when absent rather than failing on a fresh clone. When present it
// proves our offset map matches a DB the firmware demonstrably accepts.
const oraclePath = fileURLToPath(new URL("../iTunesDB", import.meta.url));
const hasOracle = existsSync(oraclePath);

describe.skipIf(!hasOracle)("real iTunesDB oracle", () => {
  const db = readItunesDb(readFileSync(oraclePath));

  test("parses all 529 tracks", () => {
    expect(db.tracks).toHaveLength(529);
  });

  test("every track has a numeric id and an iPod_Control location", () => {
    for (const t of db.tracks) {
      expect(t.id).toBeGreaterThan(0);
      expect(t.location?.startsWith(":iPod_Control:Music:")).toBe(true);
    }
  });

  test("most tracks carry title and artist strings", () => {
    const withTitle = db.tracks.filter((t) => (t.title ?? "").length > 0).length;
    const withArtist = db.tracks.filter((t) => (t.artist ?? "").length > 0).length;
    expect(withTitle).toBeGreaterThan(500);
    expect(withArtist).toBeGreaterThan(500);
  });

  test("finds a master playlist that lists every track", () => {
    const master = db.playlists.find((p) => p.isMaster);
    expect(master).toBeDefined();
    expect(master?.trackIds.length).toBe(db.tracks.length);
  });

  test("every playlist item references a real track id", () => {
    const trackIds = new Set(db.tracks.map((t) => t.id));
    for (const pl of db.playlists) {
      for (const id of pl.trackIds) expect(trackIds.has(id)).toBe(true);
    }
  });
});

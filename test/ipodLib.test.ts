import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  addToPlaylist,
  addTrack,
  backupDb,
  getOrCreatePlaylist,
  masterPlaylist,
  openIpod,
  save,
  wipeAll,
  type AudioProbe,
} from "../src/ipodLib.js";
import { readItunesDb } from "../src/itunesdbReader.js";

// A fixed probe so tests need no real audio files. It echoes deterministic stream
// info and lets each test set the tags it cares about.
const probeFor = (tags: Partial<ReturnType<() => Awaited<ReturnType<AudioProbe>>>>): AudioProbe =>
  async () => ({
    filetypeDescription: "MPEG audio file",
    lengthMs: 200_000,
    bitrate: 256,
    sampleRate: 44_100,
    ...tags,
  });

let mount: string;

/** Build a minimal mounted-iPod tree: iPod_Control with Music/ and iTunes/. */
function makeIpodTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "podscribe-ipod-"));
  mkdirSync(join(dir, "iPod_Control", "Music"), { recursive: true });
  mkdirSync(join(dir, "iPod_Control", "iTunes"), { recursive: true });
  return dir;
}

/** A throwaway source MP3 — bytes, not real audio (the probe is injected). */
function fakeSource(name = "song.mp3"): string {
  const p = join(mount, name);
  writeFileSync(p, Buffer.from("not really audio, just bytes"));
  return p;
}

beforeEach(() => {
  mount = makeIpodTree();
});
afterEach(() => {
  rmSync(mount, { recursive: true, force: true });
});

describe("openIpod", () => {
  test("resolves paths and creates a master playlist", () => {
    const db = openIpod(mount, { libraryName: "Wolfman Jack" });
    expect(db.dbPath).toBe(join(mount, "iPod_Control", "iTunes", "iTunesDB"));
    expect(db.musicDir).toBe(join(mount, "iPod_Control", "Music"));
    expect(db.tracks).toHaveLength(0);
    const master = masterPlaylist(db);
    expect(master.name).toBe("Wolfman Jack");
    expect(master.isMaster).toBe(true);
  });

  test("throws when iPod_Control is absent", () => {
    const empty = mkdtempSync(join(tmpdir(), "podscribe-empty-"));
    expect(() => openIpod(empty)).toThrow(/no iPod_Control/);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("addTrack", () => {
  test("copies audio into Music/F00, never touches the source, and joins the master playlist", async () => {
    const db = openIpod(mount);
    const src = fakeSource();
    const before = readFileSync(src);

    const track = await addTrack(db, src, {
      comment: "PLEXID:55123",
      nameStem: "ABCD",
      probe: probeFor({ title: "Le Perv", artist: "Carpenter Brut" }),
    });

    expect(track.ipodPath).toBe(":iPod_Control:Music:F00:ABCD.mp3");
    const copied = join(db.musicDir, "F00", "ABCD.mp3");
    expect(existsSync(copied)).toBe(true);
    // Source is unchanged (read-only input).
    expect(readFileSync(src).equals(before)).toBe(true);
    // Registered on the master playlist.
    expect(masterPlaylist(db).tracks).toContain(track);
    expect(track.title).toBe("Le Perv");
    expect(track.comment).toBe("PLEXID:55123");
  });

  test("rejects an unsupported format loudly, before any copy", async () => {
    const db = openIpod(mount);
    const src = fakeSource("track.flac");
    await expect(addTrack(db, src, { probe: probeFor({}) })).rejects.toThrow(/unsupported audio format/);
    expect(readdirSync(db.musicDir)).toHaveLength(0);
  });

  test("meta overlays blank probe tags, keeping the probe's stream info", async () => {
    const db = openIpod(mount);
    const track = await addTrack(db, fakeSource(), {
      nameStem: "META",
      probe: probeFor({ title: undefined, artist: undefined, album: undefined }),
      meta: { title: "Le Perv", artist: "Carpenter Brut", album: "Hydra" },
    });
    expect(track.title).toBe("Le Perv");
    expect(track.artist).toBe("Carpenter Brut");
    expect(track.album).toBe("Hydra");
    // Stream info is the probe's, untouched by meta.
    expect(track.bitrate).toBe(256);
    expect(track.sampleRate).toBe(44_100);
    expect(track.lengthMs).toBe(200_000);
  });

  test("partial meta does not clobber a tag the file already has", async () => {
    const db = openIpod(mount);
    const track = await addTrack(db, fakeSource(), {
      nameStem: "PART",
      probe: probeFor({ title: "Old", artist: "Real Artist" }),
      meta: { title: "New" },
    });
    expect(track.title).toBe("New"); // overridden
    expect(track.artist).toBe("Real Artist"); // preserved — meta omitted it
  });

  test("empty-string meta skips, never blanking a good probe tag", async () => {
    const db = openIpod(mount);
    const track = await addTrack(db, fakeSource(), {
      nameStem: "BLNK",
      probe: probeFor({ artist: "Real Artist" }),
      meta: { artist: "", title: "   " },
    });
    expect(track.artist).toBe("Real Artist"); // "" did not clobber
    expect(track.title).toBeUndefined(); // whitespace-only fell through to the (absent) probe tag
  });

  test("round-robins across F-folders", async () => {
    const db = openIpod(mount);
    // Place 51 tracks; the 51st wraps back to F00.
    for (let i = 0; i < 51; i++) {
      const t = await addTrack(db, fakeSource(`s${i}.mp3`), {
        nameStem: `T${String(i).padStart(3, "0")}`,
        probe: probeFor({}),
      });
      const expectedFolder = `F${String(i % 50).padStart(2, "0")}`;
      expect(t.ipodPath).toContain(`:${expectedFolder}:`);
    }
  });
});

describe("backupDb", () => {
  test("returns undefined when no DB exists yet", () => {
    const db = openIpod(mount);
    expect(backupDb(db)).toBeUndefined();
  });

  test("copies an existing DB to a timestamped sibling", () => {
    const db = openIpod(mount);
    writeFileSync(db.dbPath, Buffer.from("OLD DB BYTES"));
    const dest = backupDb(db);
    expect(dest).toBeDefined();
    expect(dest).toMatch(/iTunesDB\.backup-\d{8}-\d{6}$/);
    expect(readFileSync(dest as string).toString()).toBe("OLD DB BYTES");
  });
});

describe("save", () => {
  test("writes a DB the reader round-trips, with ids assigned 1..N", async () => {
    const db = openIpod(mount, { libraryName: "Wolfman Jack" });
    const a = await addTrack(db, fakeSource("a.mp3"), {
      nameStem: "AAAA",
      probe: probeFor({ title: "Le Perv", artist: "Carpenter Brut" }),
    });
    const b = await addTrack(db, fakeSource("b.mp3"), {
      nameStem: "BBBB",
      probe: probeFor({ title: "Nightmare System", artist: "Perturbator" }),
    });
    const named = getOrCreatePlaylist(db, "LIBGPOD TEST");
    addToPlaylist(named, b);

    const result = save(db, { backup: false, macTime: 0, libraryPersistentId: 0x1122334455667788n });
    expect(result.bytesWritten).toBeGreaterThan(0);
    expect(existsSync(db.dbPath)).toBe(true);

    const read = readItunesDb(readFileSync(db.dbPath));
    expect(read.tracks.map((t) => t.id)).toEqual([1, 2]);
    expect(read.tracks.map((t) => t.title)).toEqual(["Le Perv", "Nightmare System"]);

    const master = read.playlists.find((p) => p.isMaster);
    expect(master?.name).toBe("Wolfman Jack");
    expect(master?.trackIds).toEqual([1, 2]); // every track on the master playlist
    const test = read.playlists.find((p) => !p.isMaster);
    expect(test?.name).toBe("LIBGPOD TEST");
    expect(test?.trackIds).toEqual([2]); // only the one we added
    expect(a.ipodPath).toContain("F00");
  });

  test("backs up the existing DB before overwriting it", async () => {
    const db = openIpod(mount);
    writeFileSync(db.dbPath, Buffer.from("PREVIOUS"));
    await addTrack(db, fakeSource(), { nameStem: "ZZZZ", probe: probeFor({ title: "X" }) });

    const result = save(db, { macTime: 0 });
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath as string).toString()).toBe("PREVIOUS");
    // The live DB is the freshly written one, not the backup.
    expect(readFileSync(db.dbPath).equals(readFileSync(result.backupPath as string))).toBe(false);
  });
});

describe("wipeAll", () => {
  test("requires { confirm: true }", () => {
    const db = openIpod(mount);
    // @ts-expect-error — exercising the runtime guard against a missing confirm
    expect(() => wipeAll(db, {})).toThrow(/confirm: true/);
    expect(() => wipeAll(db, { confirm: false as true })).toThrow(/confirm: true/);
  });

  test("backs up, deletes all audio + the DB, and resets the model", async () => {
    const db = openIpod(mount);
    await addTrack(db, fakeSource("a.mp3"), { nameStem: "AAAA", probe: probeFor({ title: "A" }) });
    await addTrack(db, fakeSource("b.mp3"), { nameStem: "BBBB", probe: probeFor({ title: "B" }) });
    const named = getOrCreatePlaylist(db, "EXTRA");
    save(db, { backup: false, macTime: 0 });

    // Pre-wipe: DB and two audio files exist.
    expect(existsSync(db.dbPath)).toBe(true);
    expect(readdirSync(db.musicDir).length).toBeGreaterThan(0);

    const backupPath = wipeAll(db, { confirm: true });

    // Backup of the pre-wipe DB was taken.
    expect(backupPath).toBeDefined();
    expect(existsSync(backupPath as string)).toBe(true);
    // Audio and DB are gone.
    expect(readdirSync(db.musicDir)).toHaveLength(0);
    expect(existsSync(db.dbPath)).toBe(false);
    // Model reset to one empty master playlist.
    expect(db.tracks).toHaveLength(0);
    expect(db.playlists).toHaveLength(1);
    expect(masterPlaylist(db).tracks).toHaveLength(0);
    expect(db.playlists.includes(named)).toBe(false);
  });

  test("returns undefined when there is no DB to back up", () => {
    const db = openIpod(mount);
    expect(wipeAll(db, { confirm: true })).toBeUndefined();
  });
});

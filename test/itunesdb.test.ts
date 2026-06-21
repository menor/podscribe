import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  buildLocationMhod,
  buildMhip,
  buildMhit,
  buildMhyp,
  buildPositionMhod,
  buildStringMhod,
  MhodType,
  serializeItunesDb,
  toMacTime,
  type ItunesDbModel,
} from "../src/itunesdb.js";
import { readItunesDb } from "../src/itunesdbReader.js";

const magic = (b: Buffer) => b.toString("ascii", 0, 4);
const u32 = (b: Buffer, o: number) => b.readUInt32LE(o);

describe("string mhod", () => {
  test("header, lengths, and UTF-16LE payload", () => {
    const b = buildStringMhod(MhodType.Title, "Leather Teeth");
    expect(magic(b)).toBe("mhod");
    expect(u32(b, 0x04)).toBe(0x18); // base header length
    expect(u32(b, 0x0c)).toBe(MhodType.Title);
    const byteLen = Buffer.from("Leather Teeth", "utf16le").length;
    expect(byteLen).toBe(26);
    expect(u32(b, 0x1c)).toBe(byteLen); // string length in bytes
    expect(u32(b, 0x20)).toBe(1); // UTF-16 encoding flag
    expect(u32(b, 0x08)).toBe(0x28 + byteLen); // total length
    expect(b.length).toBe(0x28 + byteLen);
    expect(b.toString("utf16le", 0x28)).toBe("Leather Teeth");
  });

  test("location mhod is a type-2 string mhod", () => {
    const path = ":iPod_Control:Music:F07:ABCD.mp3";
    const b = buildLocationMhod(path);
    expect(u32(b, 0x0c)).toBe(MhodType.Location);
    expect(b.toString("utf16le", 0x28)).toBe(path);
  });
});

describe("position mhod", () => {
  test("type 100, fixed 0x2C total, position at 0x18", () => {
    const b = buildPositionMhod(5);
    expect(magic(b)).toBe("mhod");
    expect(u32(b, 0x08)).toBe(0x2c);
    expect(u32(b, 0x0c)).toBe(MhodType.PlaylistPosition);
    expect(u32(b, 0x18)).toBe(5);
    expect(b.length).toBe(0x2c);
  });
});

describe("mhit", () => {
  test("header fields and child mhod count", () => {
    const macTime = toMacTime(1_700_000_000);
    const b = buildMhit(
      {
        id: 42,
        title: "T",
        artist: "A",
        ipodPath: ":iPod_Control:Music:F00:X.mp3",
        sizeBytes: 1234,
        lengthMs: 5678,
        bitrate: 320,
        sampleRate: 44100,
        trackNumber: 3,
        totalTracks: 9,
        year: 2018,
      },
      macTime,
    );
    expect(magic(b)).toBe("mhit");
    expect(u32(b, 0x04)).toBe(0x9c);
    expect(u32(b, 0x0c)).toBe(3); // title + artist + location
    expect(u32(b, 0x10)).toBe(42); // track id
    expect(u32(b, 0x14)).toBe(1); // visible
    expect(u32(b, 0x20)).toBe(macTime);
    expect(u32(b, 0x24)).toBe(1234); // size
    expect(u32(b, 0x28)).toBe(5678); // length ms
    expect(u32(b, 0x2c)).toBe(3); // track number
    expect(u32(b, 0x30)).toBe(9); // total tracks
    expect(u32(b, 0x34)).toBe(2018); // year
    expect(u32(b, 0x38)).toBe(320); // bitrate
    expect(u32(b, 0x3c)).toBe(44100 * 0x10000); // sample rate << 16
    expect(u32(b, 0x68)).toBe(macTime); // date added
    expect(u32(b, 0x08)).toBe(b.length); // total length consistent
  });

  test("48 kHz sample rate << 16 stays inside uint32", () => {
    const b = buildMhit(
      { id: 1, ipodPath: ":x", sizeBytes: 0, lengthMs: 0, bitrate: 0, sampleRate: 48000 },
      0,
    );
    expect(u32(b, 0x3c)).toBe(48000 * 0x10000);
    expect(48000 * 0x10000).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("mhip / mhyp", () => {
  test("mhip carries the track id at 0x18 and one position mhod", () => {
    const b = buildMhip(112, 1);
    expect(magic(b)).toBe("mhip");
    expect(u32(b, 0x04)).toBe(0x4c);
    expect(u32(b, 0x0c)).toBe(1); // one mhod
    expect(u32(b, 0x18)).toBe(112); // track id
    expect(magic(b.subarray(0x4c))).toBe("mhod"); // position mhod follows header
  });

  test("mhyp records master flag, mhod count, and mhip count", () => {
    const b = buildMhyp({ name: "Library", isMaster: true, trackIds: [1, 2, 3] });
    expect(magic(b)).toBe("mhyp");
    expect(u32(b, 0x04)).toBe(0xb8);
    expect(u32(b, 0x0c)).toBe(1); // title mhod
    expect(u32(b, 0x10)).toBe(3); // three mhips
    expect(u32(b, 0x14)).toBe(1); // master
    expect(u32(b, 0x08)).toBe(b.length);
  });
});

describe("full database round-trip", () => {
  const model: ItunesDbModel = {
    tracks: [
      {
        id: 1,
        title: "Le Perv",
        artist: "Carpenter Brut",
        album: "Trilogy",
        genre: "Synth",
        filetypeDescription: "MPEG audio file",
        comment: "PLEXID:55123",
        ipodPath: ":iPod_Control:Music:F00:LEPV.mp3",
        sizeBytes: 9_852_319,
        lengthMs: 233_528,
        bitrate: 320,
        sampleRate: 44100,
        trackNumber: 6,
        totalTracks: 10,
        year: 2015,
      },
      {
        id: 2,
        title: "Nightmare System",
        artist: "Perturbator",
        ipodPath: ":iPod_Control:Music:F01:NSYS.mp3",
        sizeBytes: 8_000_000,
        lengthMs: 300_000,
        bitrate: 256,
        sampleRate: 44100,
      },
    ],
    playlists: [
      { name: "Wolfman Jack", isMaster: true, trackIds: [1, 2] },
      { name: "LIBGPOD TEST", trackIds: [2] },
    ],
  };

  test("serialize then read recovers tracks and playlists", () => {
    const buf = serializeItunesDb(model, { macTime: toMacTime(1_700_000_000) });
    const db = readItunesDb(buf);

    expect(db.tracks.map((t) => t.id)).toEqual([1, 2]);
    expect(db.tracks[0]).toMatchObject({
      id: 1,
      title: "Le Perv",
      artist: "Carpenter Brut",
      album: "Trilogy",
      genre: "Synth",
      comment: "PLEXID:55123",
      location: ":iPod_Control:Music:F00:LEPV.mp3",
    });
    expect(db.tracks[1]).toMatchObject({ id: 2, title: "Nightmare System" });
    expect(db.tracks[1]?.album).toBeUndefined(); // no album mhod was written

    expect(db.playlists).toHaveLength(2);
    const master = db.playlists.find((p) => p.isMaster);
    expect(master?.name).toBe("Wolfman Jack");
    expect(master?.trackIds).toEqual([1, 2]);
    const named = db.playlists.find((p) => !p.isMaster);
    expect(named?.name).toBe("LIBGPOD TEST");
    expect(named?.trackIds).toEqual([2]);
  });

  test("mhbd reports total length equal to the buffer size", () => {
    const buf = serializeItunesDb(model);
    expect(u32(buf, 0x08)).toBe(buf.length);
    expect(u32(buf, 0x14)).toBe(2); // two mhsd sets
  });

  test("serialization is deterministic given fixed options", () => {
    const opts = { macTime: toMacTime(1_700_000_000), libraryPersistentId: 0x1122334455667788n };
    const a = serializeItunesDb(model, opts);
    const b = serializeItunesDb(model, opts);
    expect(a.equals(b)).toBe(true);
    expect(u32(a, 0x18)).toBe(0x55667788); // low word of persistent id
  });
});

describe("byte-for-byte fixture (regression lock)", () => {
  // Deterministic 1-track / 1-playlist DB. Total size derived by hand:
  //   mhbd header                                            244
  //   track set:   mhsd 96 + mhlt 92 + mhit(156 + mhods)    = 568
  //     mhit mhods: title "Test Song" 40+18=58,
  //                 artist "Test Artist" 40+22=62,
  //                 location (32 chars) 40+64=104  -> mhit 380
  //   playlist set: mhsd 96 + mhlp 92 + mhyp(184+...)       = 556
  //     mhyp: title "Wolfman Jack" 40+24=64, mhip (76 + pos mhod 44)=120 -> 368
  //   total = 244 + 568 + 556                               = 1368
  const fixtureModel: ItunesDbModel = {
    tracks: [
      {
        id: 1,
        title: "Test Song",
        artist: "Test Artist",
        ipodPath: ":iPod_Control:Music:F00:TEST.mp3",
        sizeBytes: 1_048_576,
        lengthMs: 60_000,
        bitrate: 128,
        sampleRate: 44_100,
      },
    ],
    playlists: [{ name: "Wolfman Jack", isMaster: true, trackIds: [1] }],
  };
  const fixtureOpts = {
    macTime: toMacTime(1_700_000_000),
    libraryPersistentId: 0x1122334455667788n,
  };

  test("matches the committed fixture bytes exactly", () => {
    const buf = serializeItunesDb(fixtureModel, fixtureOpts);
    expect(buf.length).toBe(1368); // hand-computed above
    const fixturePath = fileURLToPath(
      new URL("./fixtures/one-track-one-playlist.db.bin", import.meta.url),
    );
    const expected = readFileSync(fixturePath);
    expect(buf.equals(expected)).toBe(true);
  });
});

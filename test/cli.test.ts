import { describe, expect, test } from "vitest";
import { assertFat32, parseCliArgs } from "../src/cli/ipod-add.js";

describe("parseCliArgs", () => {
  test("parses mount, playlist, and multiple files", () => {
    const args = parseCliArgs([
      "--mount",
      "/Volumes/IPOD",
      "--playlist",
      "LIBGPOD TEST",
      "--files",
      "a.mp3",
      "b.mp3",
      "--comment",
      "PLEXID:55123",
    ]);
    expect(args.mount).toBe("/Volumes/IPOD");
    expect(args.playlist).toBe("LIBGPOD TEST");
    expect(args.files).toEqual(["a.mp3", "b.mp3"]);
    expect(args.comment).toBe("PLEXID:55123");
    expect(args.skipFsCheck).toBe(false);
  });

  test("accepts files as trailing positionals too", () => {
    const args = parseCliArgs(["--mount", "/m", "--playlist", "P", "--files", "a.mp3", "b.mp3"]);
    expect(args.files).toEqual(["a.mp3", "b.mp3"]);
  });

  test("throws naming every missing required argument", () => {
    expect(() => parseCliArgs([])).toThrow(/--mount.*--playlist.*--files/s);
  });
});

describe("assertFat32", () => {
  test("passes on a FAT32 mount", () => {
    expect(() => assertFat32("/Volumes/IPOD", () => "MS-DOS FAT32")).not.toThrow();
  });

  test("stops loudly on an HFS+ mount", () => {
    expect(() => assertFat32("/Volumes/IPOD", () => "Mac OS Extended (Journaled)")).toThrow(
      /not FAT32/,
    );
  });

  test("warns but continues when the filesystem is unknown", () => {
    expect(() => assertFat32("/Volumes/IPOD", () => undefined)).not.toThrow();
  });
});

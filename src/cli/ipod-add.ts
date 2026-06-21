#!/usr/bin/env node
/**
 * ipod-add — the thin demo CLI that drives podscribe's on-device acceptance test.
 *
 * It is deliberately minimal: locate the iPod, back up its DB, copy some MP3s onto it,
 * put them on a named playlist (and the master), and write the DB durably. All real
 * logic lives in the library (`src/ipodLib.ts`); this file is glue plus a FAT32 guard.
 *
 *   ipod-add --mount /Volumes/IPOD --playlist "LIBGPOD TEST" --files a.mp3 b.mp3
 *
 * There is NO `--wipe`: deleting files maps to the deferred `wipeAll`. The v0.1 device
 * test deletes existing audio manually in Finder, after the backup. See the plan.
 */

import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import {
  addToPlaylist,
  addTrack,
  backupDb,
  getOrCreatePlaylist,
  openIpod,
  save,
} from "../ipodLib.js";

export interface CliArgs {
  mount: string;
  playlist: string;
  files: string[];
  comment?: string;
  library?: string;
  skipFsCheck: boolean;
}

const USAGE = `ipod-add — copy MP3s onto a mounted iPod and write its iTunesDB

Usage:
  ipod-add --mount <path> --playlist <name> --files <f1> [f2 ...] [options]

Required:
  --mount <path>       iPod mount point, e.g. /Volumes/IPOD
  --playlist <name>    named playlist the tracks join (also the master playlist)
  --files <f...>       one or more audio files (mp3/m4a/aac/wav/aiff)

Options:
  --comment <text>     comment stamped on every track, e.g. PLEXID:55123
  --library <name>     master playlist name (default: iPod)
  --skip-fs-check      do not verify the mount is FAT32 (use with care)
  -h, --help           show this help

There is no --wipe: delete existing audio manually in Finder first (see plan).`;

/** Parse argv into validated CliArgs, or throw with a loud, specific message. */
export function parseCliArgs(argv: string[]): CliArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      mount: { type: "string" },
      playlist: { type: "string" },
      files: { type: "string", multiple: true },
      comment: { type: "string" },
      library: { type: "string" },
      "skip-fs-check": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  const files = [...(values.files ?? []), ...positionals];
  const missing: string[] = [];
  if (values.mount === undefined) missing.push("--mount");
  if (values.playlist === undefined) missing.push("--playlist");
  if (files.length === 0) missing.push("--files");
  if (missing.length > 0) {
    throw new Error(`missing required argument(s): ${missing.join(", ")}\n\n${USAGE}`);
  }

  return {
    mount: values.mount as string,
    playlist: values.playlist as string,
    files,
    comment: values.comment,
    library: values.library,
    skipFsCheck: values["skip-fs-check"] ?? false,
  };
}

/** Returns the filesystem personality of a mount, or undefined if it can't be read. */
export type FsProbe = (mountPath: string) => string | undefined;

/** Default probe: ask macOS `diskutil` for the filesystem personality. */
const diskutilProbe: FsProbe = (mountPath) => {
  try {
    const out = execSync(`diskutil info ${JSON.stringify(mountPath)}`, { encoding: "utf8" });
    return /File System Personality:\s*(.+)/.exec(out)?.[1]?.trim();
  } catch {
    return undefined;
  }
};

/**
 * Insist the mount is FAT32 ("Windows" format). The 5.5-gen firmware writes a FAT32
 * iPod; an HFS+ ("Mac OS Extended") iPod is a different, Mac-formatted layout podscribe
 * does not target. Stops loudly on HFS+. If the filesystem can't be determined, warns
 * and continues rather than blocking a valid device.
 */
export function assertFat32(mountPath: string, probe: FsProbe = diskutilProbe): void {
  const fs = probe(mountPath);
  if (fs === undefined) {
    console.warn(`! Could not determine the filesystem of ${mountPath}. Proceeding — ensure it is FAT32.`);
    return;
  }
  if (/FAT/i.test(fs)) {
    console.log(`Filesystem OK: ${fs}`);
    return;
  }
  if (/HFS|Mac OS Extended|APFS/i.test(fs)) {
    throw new Error(
      `${mountPath} is "${fs}", not FAT32. A 5.5-gen iPod must be Windows-formatted (FAT32). ` +
        `Restore it as a Windows iPod in Finder/iTunes, then retry.`,
    );
  }
  console.warn(`! Unrecognized filesystem "${fs}" on ${mountPath}. Proceeding — ensure it is FAT32.`);
}

/** Run the CLI: guard the mount, back up, copy tracks, write the DB. */
export async function run(argv: string[]): Promise<void> {
  const args = parseCliArgs(argv);

  if (!args.skipFsCheck) assertFat32(args.mount);

  const db = openIpod(args.mount, { libraryName: args.library });
  // Back up once here — before addTrack copies any audio (the first device write).
  // save() would otherwise back up again, so tell it not to.
  backupDb(db);

  const named = getOrCreatePlaylist(db, args.playlist);
  for (const file of args.files) {
    const track = await addTrack(db, file, { comment: args.comment });
    addToPlaylist(named, track);
    console.log(`Added: ${track.artist ?? "?"} — ${track.title ?? "?"}  →  ${track.ipodPath}`);
  }

  save(db, { backup: false });
}

// Run only when invoked directly, not when imported by a test.
if (import.meta.url === `file://${process.argv[1]}`) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    console.error(`\nipod-add failed: ${(err as Error).message}`);
    process.exit(1);
  });
}

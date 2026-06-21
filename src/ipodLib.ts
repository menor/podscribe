/**
 * iPod filesystem operations on top of the pure serializer (`src/itunesdb.ts`).
 *
 * This layer is where podscribe touches a real device: it locates `iPod_Control`,
 * copies audio into `iPod_Control/Music/F00..F49`, reads tags, and writes the
 * iTunesDB durably. The serializer stays pure; all I/O lives here.
 *
 * Inherited constraints, enforced below:
 *  - NEVER modify a source music file or its tags. Source files are read-only inputs.
 *  - Before ANY iPod write, back up the existing iTunesDB (timestamped, never overwrite).
 *  - Fail loudly, naming the offending track and reason — never skip silently.
 *  - On save: write → fsync file → fsync dir → OS `sync` → loud "safe to eject".
 *
 * `wipeAll` is intentionally NOT implemented here yet. It is the only file-deleting
 * operation; per the plan it is sequenced AFTER the writer is proven on-device, so no
 * untested delete code ever runs against the user's iPod. v0.1's device test deletes
 * audio manually in Finder.
 */

import { execSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  writeSync,
} from "node:fs";
import { extname, join } from "node:path";
import {
  type ItunesDbModel,
  type SerializeOptions,
  serializeItunesDb,
} from "./itunesdb.js";

// ---------------------------------------------------------------------------
// Model — higher level than the serializer's. Ids are NOT stored here; they are
// ephemeral and assigned 1..N only at save time. Playlists reference track
// objects directly, so identity survives id reassignment.
// ---------------------------------------------------------------------------

/** A track staged on the iPod: tag-derived metadata plus its on-device location. */
export interface IpodTrack {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  /** Human filetype description, e.g. "MPEG audio file". */
  filetypeDescription?: string;
  /** Free-text comment. podscribe stamps `PLEXID:<ratingKey>` for cross-sync identity. */
  comment?: string;
  /** Colon-separated on-iPod path, e.g. ":iPod_Control:Music:F07:ABCD.mp3". */
  ipodPath: string;
  sizeBytes: number;
  lengthMs: number;
  bitrate: number;
  sampleRate: number;
  trackNumber?: number;
  totalTracks?: number;
  year?: number;
}

export interface IpodPlaylist {
  name: string;
  /** Exactly one playlist — the library/master — carries this flag. */
  isMaster: boolean;
  /** Member tracks, in order, by reference. */
  tracks: IpodTrack[];
}

/** A mounted iPod: resolved paths plus the in-memory track/playlist model. */
export interface IpodDb {
  mountPath: string;
  controlDir: string;
  musicDir: string;
  itunesDir: string;
  dbPath: string;
  tracks: IpodTrack[];
  playlists: IpodPlaylist[];
}

/** What probing an audio file yields. Tags are best-effort; the rest is required. */
export interface ProbedAudio {
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  year?: number;
  trackNumber?: number;
  totalTracks?: number;
  filetypeDescription: string;
  lengthMs: number;
  bitrate: number;
  sampleRate: number;
}

/** Reads tags + stream info from an audio file. Injectable so tests need no real audio. */
export type AudioProbe = (filePath: string) => Promise<ProbedAudio>;

// ---------------------------------------------------------------------------
// Format support
// ---------------------------------------------------------------------------

/** Extensions the 5.5-gen firmware plays that podscribe supports in v0.1. */
const SUPPORTED: Record<string, string> = {
  ".mp3": "MPEG audio file",
  ".m4a": "AAC audio file",
  ".aac": "AAC audio file",
  ".mp4": "AAC audio file",
  ".wav": "WAV audio file",
  ".aif": "AIFF audio file",
  ".aiff": "AIFF audio file",
};

function describeType(ext: string): string {
  const desc = SUPPORTED[ext.toLowerCase()];
  if (desc === undefined) {
    throw new Error(
      `unsupported audio format "${ext}". Supported: ${Object.keys(SUPPORTED).join(", ")}`,
    );
  }
  return desc;
}

// ---------------------------------------------------------------------------
// openIpod / backupDb
// ---------------------------------------------------------------------------

/** Find `iPod_Control` under the mount, tolerating case differences. */
function findControlDir(mountPath: string): string {
  const exact = join(mountPath, "iPod_Control");
  if (existsSync(exact)) return exact;
  for (const entry of readdirSync(mountPath)) {
    if (entry.toLowerCase() === "ipod_control") return join(mountPath, entry);
  }
  throw new Error(
    `no iPod_Control under ${mountPath} — is the iPod mounted and FAT32 ("Windows") formatted?`,
  );
}

export interface OpenIpodOptions {
  /** Name of the master/library playlist. Defaults to "iPod". */
  libraryName?: string;
}

/**
 * Locate the iPod under `mountPath` and start an empty in-memory model with a
 * master playlist. Existing tracks are NOT loaded: v0.1 wipes-then-writes, and the
 * reader stays out of the production path. `backupDb` still copies whatever DB the
 * device currently holds.
 */
export function openIpod(mountPath: string, opts: OpenIpodOptions = {}): IpodDb {
  const controlDir = findControlDir(mountPath);
  const itunesDir = join(controlDir, "iTunes");
  const master: IpodPlaylist = { name: opts.libraryName ?? "iPod", isMaster: true, tracks: [] };
  return {
    mountPath,
    controlDir,
    musicDir: join(controlDir, "Music"),
    itunesDir,
    dbPath: join(itunesDir, "iTunesDB"),
    tracks: [],
    playlists: [master],
  };
}

function timestamp(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/**
 * Copy the existing iTunesDB to a timestamped sibling and return its path.
 * Returns undefined when no DB exists yet (a blank/wiped device). Never overwrites:
 * a name collision throws rather than clobbering an earlier backup.
 */
export function backupDb(db: IpodDb): string | undefined {
  if (!existsSync(db.dbPath)) {
    console.log(`No existing iTunesDB at ${db.dbPath} — nothing to back up.`);
    return undefined;
  }
  const dest = `${db.dbPath}.backup-${timestamp()}`;
  if (existsSync(dest)) throw new Error(`backup already exists, refusing to overwrite: ${dest}`);
  copyFileSync(db.dbPath, dest);
  console.log(`Backed up iTunesDB → ${dest}`);
  return dest;
}

// ---------------------------------------------------------------------------
// addTrack
// ---------------------------------------------------------------------------

const STEM_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Four random uppercase-alphanumeric characters, libgpod-style. */
function randomStem(): string {
  let s = "";
  for (let i = 0; i < 4; i++) s += STEM_CHARS[Math.floor(Math.random() * STEM_CHARS.length)];
  return s;
}

/** Default probe: read tags + stream info via music-metadata. */
async function probeWithMusicMetadata(filePath: string): Promise<ProbedAudio> {
  const { parseFile } = await import("music-metadata");
  const meta = await parseFile(filePath);
  const f = meta.format;
  const c = meta.common;
  return {
    title: c.title,
    artist: c.artist,
    album: c.album,
    genre: c.genre?.[0],
    year: c.year,
    trackNumber: c.track?.no ?? undefined,
    totalTracks: c.track?.of ?? undefined,
    filetypeDescription: describeType(extname(filePath)),
    lengthMs: f.duration !== undefined ? Math.round(f.duration * 1000) : 0,
    bitrate: f.bitrate !== undefined ? Math.round(f.bitrate / 1000) : 0,
    sampleRate: f.sampleRate ?? 44100,
  };
}

export interface AddTrackOptions {
  /** Stamped into the comment mhod, e.g. `PLEXID:55123`. */
  comment?: string;
  /** Override the tag/stream probe. Tests inject this so they need no real audio. */
  probe?: AudioProbe;
  /** Override the generated on-disk filename stem (default: 4 random chars). */
  nameStem?: string;
}

/**
 * Copy `filePath` into the iPod, read its tags, and register it on the master
 * playlist. The source file is never modified. Throws loudly on an unsupported
 * format, naming the file — it is never skipped silently.
 *
 * [NOTE] Every track must appear on the master playlist or the old-format firmware
 * won't display it. addTrack guarantees that here.
 */
export async function addTrack(
  db: IpodDb,
  filePath: string,
  opts: AddTrackOptions = {},
): Promise<IpodTrack> {
  const ext = extname(filePath);
  describeType(ext); // guard before any I/O — throws on unsupported format

  let probed: ProbedAudio;
  let sizeBytes: number;
  try {
    probed = await (opts.probe ?? probeWithMusicMetadata)(filePath);
    sizeBytes = statSync(filePath).size;
  } catch (err) {
    throw new Error(`failed to read "${filePath}": ${(err as Error).message}`);
  }

  // Round-robin across F00..F49 so no single folder grows unbounded.
  const folder = `F${String(db.tracks.length % 50).padStart(2, "0")}`;
  const folderDir = join(db.musicDir, folder);
  mkdirSync(folderDir, { recursive: true });

  const filename = `${opts.nameStem ?? randomStem()}${ext.toLowerCase()}`;
  copyFileSync(filePath, join(folderDir, filename));

  const track: IpodTrack = {
    title: probed.title,
    artist: probed.artist,
    album: probed.album,
    genre: probed.genre,
    filetypeDescription: probed.filetypeDescription,
    comment: opts.comment,
    ipodPath: `:iPod_Control:Music:${folder}:${filename}`,
    sizeBytes,
    lengthMs: probed.lengthMs,
    bitrate: probed.bitrate,
    sampleRate: probed.sampleRate,
    trackNumber: probed.trackNumber,
    totalTracks: probed.totalTracks,
    year: probed.year,
  };

  db.tracks.push(track);
  masterPlaylist(db).tracks.push(track);
  return track;
}

// ---------------------------------------------------------------------------
// Playlist helpers
// ---------------------------------------------------------------------------

/** The master/library playlist. Throws if absent — openIpod always creates one. */
export function masterPlaylist(db: IpodDb): IpodPlaylist {
  const master = db.playlists.find((p) => p.isMaster);
  if (master === undefined) throw new Error("no master playlist — db was not opened via openIpod");
  return master;
}

/** Fetch a named (non-master) playlist, creating an empty one if needed. */
export function getOrCreatePlaylist(db: IpodDb, name: string): IpodPlaylist {
  const existing = db.playlists.find((p) => !p.isMaster && p.name === name);
  if (existing !== undefined) return existing;
  const pl: IpodPlaylist = { name, isMaster: false, tracks: [] };
  db.playlists.push(pl);
  return pl;
}

/** Append a track to a playlist if it is not already a member. */
export function addToPlaylist(pl: IpodPlaylist, track: IpodTrack): void {
  if (!pl.tracks.includes(track)) pl.tracks.push(track);
}

// ---------------------------------------------------------------------------
// save
// ---------------------------------------------------------------------------

export interface SaveOptions extends SerializeOptions {
  /** Back up the existing DB before writing. Default true. Only disable for tests. */
  backup?: boolean;
}

export interface SaveResult {
  dbPath: string;
  bytesWritten: number;
  backupPath?: string;
}

/**
 * Serialize the model and write the iTunesDB durably: back up first, write, fsync the
 * file, fsync the directory, then OS `sync`. Track ids are assigned 1..N here and
 * nowhere else. Prints a loud safe-to-eject notice on success.
 */
export function save(db: IpodDb, opts: SaveOptions = {}): SaveResult {
  const backupPath = opts.backup === false ? undefined : backupDb(db);

  // Assign ephemeral ids and resolve playlist membership through them.
  const idOf = new Map<IpodTrack, number>();
  db.tracks.forEach((t, i) => idOf.set(t, i + 1));

  const model: ItunesDbModel = {
    tracks: db.tracks.map((t) => ({ id: idOf.get(t) as number, ...t })),
    playlists: db.playlists.map((pl) => ({
      name: pl.name,
      isMaster: pl.isMaster,
      trackIds: pl.tracks.map((t) => idOf.get(t) as number),
    })),
  };

  const buf = serializeItunesDb(model, opts);

  mkdirSync(db.itunesDir, { recursive: true });
  const fd = openSync(db.dbPath, "w");
  try {
    writeSync(fd, buf);
    fsyncSync(fd); // flush this file's data to the device
  } finally {
    closeSync(fd);
  }
  fsyncDir(db.itunesDir); // flush the directory entry too
  try {
    execSync("sync"); // ask the OS to flush all buffers
  } catch {
    // sync is best-effort; the fsyncs above already covered our file.
  }

  console.log(
    [
      "",
      "==============================================================",
      `  iTunesDB written: ${db.dbPath}`,
      `  ${buf.length} bytes · ${db.tracks.length} tracks · ${db.playlists.length} playlists`,
      backupPath ? `  Previous DB backed up to: ${backupPath}` : "  (no previous DB to back up)",
      "  Buffers flushed. It is now SAFE TO EJECT the iPod.",
      "==============================================================",
      "",
    ].join("\n"),
  );

  return { dbPath: db.dbPath, bytesWritten: buf.length, backupPath };
}

/** fsync a directory so its updated entries reach disk. Best-effort across platforms. */
function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Some platforms reject fsync on a directory fd; the file fsync is the load-bearing one.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Old-format iTunesDB serializer (5.5-gen iPod Video, A1136 — no checksum).
 *
 * Every builder returns a Buffer whose header length and total length fields are
 * already filled in. Parents simply concatenate their children. See
 * `docs/itunesdb-format.md` for the byte layout each builder implements; offsets in
 * the comments below refer to that document.
 *
 * The serializer is pure: give it a model with track ids already assigned and it
 * returns bytes. It performs no file I/O and knows nothing about iPods or Plex.
 */

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** One track. `id` is ephemeral — assigned 1..N at serialize time, never persisted. */
export interface TrackEntry {
  id: number;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  /** Human filetype description, e.g. "MPEG audio file". */
  filetypeDescription?: string;
  /** Free-text comment. podscribe stamps `PLEXID:<ratingKey>` here for cross-sync identity. */
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

export interface PlaylistEntry {
  name: string;
  /** The master/library playlist (mhyp flag = 1). Exactly one should be true. */
  isMaster?: boolean;
  /** Track ids, in playlist order. Each must match a TrackEntry.id. */
  trackIds: number[];
}

export interface ItunesDbModel {
  tracks: TrackEntry[];
  playlists: PlaylistEntry[];
}

export interface SerializeOptions {
  /** Mac timestamp (seconds since 1904-01-01) stamped into time fields. Injectable for determinism. */
  macTime?: number;
  /** 8-byte library persistent id written into mhbd. Injectable for determinism. */
  libraryPersistentId?: bigint;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seconds between the Mac epoch (1904-01-01) and the Unix epoch (1970-01-01). */
const MAC_EPOCH_OFFSET = 2_082_844_800;

const MHBD_HEADER_LEN = 0xf4;
const MHSD_HEADER_LEN = 0x60;
const MHLT_HEADER_LEN = 0x5c;
const MHLP_HEADER_LEN = 0x5c;
const MHIT_HEADER_LEN = 0x9c;
const MHYP_HEADER_LEN = 0xb8;
const MHIP_HEADER_LEN = 0x4c;
const MHOD_BASE_HEADER_LEN = 0x18;

/** mhsd set types. */
export const MhsdType = { Tracks: 1, Playlists: 2, Podcasts: 3 } as const;

/** mhod data-object types. */
export const MhodType = {
  Title: 1,
  Location: 2,
  Album: 3,
  Artist: 4,
  Genre: 5,
  Filetype: 6,
  Comment: 8,
  PlaylistPosition: 100,
} as const;

/** Database version field (mhbd 0x10). See docs/itunesdb-format.md. */
const DB_VERSION = 0x19;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert a Unix-epoch seconds value (or now) to a Mac-epoch timestamp. */
export function toMacTime(unixSeconds: number = Math.floor(Date.now() / 1000)): number {
  return (unixSeconds + MAC_EPOCH_OFFSET) >>> 0;
}

/** Write a 4-byte ASCII magic + header length into a fresh header buffer. */
function header(magic: string, headerLen: number): Buffer {
  const h = Buffer.alloc(headerLen);
  h.write(magic, 0, "ascii");
  h.writeUInt32LE(headerLen, 0x04);
  return h;
}

// ---------------------------------------------------------------------------
// mhod — data objects
// ---------------------------------------------------------------------------

/**
 * String data object (title/location/album/artist/genre/filetype/comment).
 * Layout: 0x18 base header, then a 16-byte sub-header, then the UTF-16LE string.
 */
export function buildStringMhod(type: number, value: string): Buffer {
  const str = Buffer.from(value, "utf16le");
  const h = header("mhod", MHOD_BASE_HEADER_LEN);
  // total length is patched after we know the body size
  h.writeUInt32LE(type, 0x0c);

  const sub = Buffer.alloc(0x10);
  sub.writeUInt32LE(1, 0x00); // 0x18 position / flag
  sub.writeUInt32LE(str.length, 0x04); // 0x1C string length in bytes
  sub.writeUInt32LE(1, 0x08); // 0x20 encoding: 1 = UTF-16LE
  // 0x24 unknown stays 0

  const buf = Buffer.concat([h, sub, str]);
  buf.writeUInt32LE(buf.length, 0x08); // total length
  return buf;
}

/** Convenience: the location mhod is a string mhod holding the colon-separated path. */
export function buildLocationMhod(ipodPath: string): Buffer {
  return buildStringMhod(MhodType.Location, ipodPath);
}

/** Playlist position index (type 100), the single child of an mhip. Total length 0x2C. */
export function buildPositionMhod(position: number): Buffer {
  const h = header("mhod", MHOD_BASE_HEADER_LEN);
  const buf = Buffer.concat([h, Buffer.alloc(0x14)]); // 0x2C total
  buf.writeUInt32LE(0x2c, 0x08); // total length
  buf.writeUInt32LE(MhodType.PlaylistPosition, 0x0c);
  buf.writeUInt32LE(position, 0x18);
  return buf;
}

// ---------------------------------------------------------------------------
// mhit — track item
// ---------------------------------------------------------------------------

export function buildMhit(track: TrackEntry, macTime: number): Buffer {
  // Order mirrors the oracle: descriptive strings first, location last.
  const mhods: Buffer[] = [];
  if (track.title !== undefined) mhods.push(buildStringMhod(MhodType.Title, track.title));
  if (track.artist !== undefined) mhods.push(buildStringMhod(MhodType.Artist, track.artist));
  if (track.album !== undefined) mhods.push(buildStringMhod(MhodType.Album, track.album));
  if (track.genre !== undefined) mhods.push(buildStringMhod(MhodType.Genre, track.genre));
  if (track.filetypeDescription !== undefined)
    mhods.push(buildStringMhod(MhodType.Filetype, track.filetypeDescription));
  if (track.comment !== undefined) mhods.push(buildStringMhod(MhodType.Comment, track.comment));
  mhods.push(buildLocationMhod(track.ipodPath));

  const body = Buffer.concat(mhods);
  const h = header("mhit", MHIT_HEADER_LEN);
  h.writeUInt32LE(MHIT_HEADER_LEN + body.length, 0x08); // total length
  h.writeUInt32LE(mhods.length, 0x0c); // number of mhods
  h.writeUInt32LE(track.id, 0x10);
  h.writeUInt32LE(1, 0x14); // visible
  h.writeUInt32LE(macTime, 0x20); // last modified
  h.writeUInt32LE(track.sizeBytes >>> 0, 0x24);
  h.writeUInt32LE(track.lengthMs >>> 0, 0x28);
  h.writeUInt32LE((track.trackNumber ?? 0) >>> 0, 0x2c);
  h.writeUInt32LE((track.totalTracks ?? 0) >>> 0, 0x30);
  h.writeUInt32LE((track.year ?? 0) >>> 0, 0x34);
  h.writeUInt32LE(track.bitrate >>> 0, 0x38);
  h.writeUInt32LE((track.sampleRate * 0x10000) >>> 0, 0x3c); // rate << 16
  h.writeUInt32LE(macTime, 0x68); // date added
  return Buffer.concat([h, body]);
}

// ---------------------------------------------------------------------------
// mhip — playlist item
// ---------------------------------------------------------------------------

export function buildMhip(trackId: number, position: number): Buffer {
  const posMhod = buildPositionMhod(position);
  const h = header("mhip", MHIP_HEADER_LEN);
  h.writeUInt32LE(MHIP_HEADER_LEN + posMhod.length, 0x08); // total length
  h.writeUInt32LE(1, 0x0c); // number of mhods
  // 0x10 podcast grouping stays 0
  h.writeUInt32LE(position, 0x14); // group id
  h.writeUInt32LE(trackId, 0x18); // track id — links to an mhit
  return Buffer.concat([h, posMhod]);
}

// ---------------------------------------------------------------------------
// mhyp — playlist
// ---------------------------------------------------------------------------

export function buildMhyp(playlist: PlaylistEntry): Buffer {
  const title = buildStringMhod(MhodType.Title, playlist.name);
  const items = playlist.trackIds.map((id, i) => buildMhip(id, i + 1));
  const body = Buffer.concat([title, ...items]);

  const h = header("mhyp", MHYP_HEADER_LEN);
  h.writeUInt32LE(MHYP_HEADER_LEN + body.length, 0x08); // total length
  h.writeUInt32LE(1, 0x0c); // number of mhods (the title)
  h.writeUInt32LE(items.length, 0x10); // number of mhips
  h.writeUInt32LE(playlist.isMaster ? 1 : 0, 0x14); // master flag
  return Buffer.concat([h, body]);
}

// ---------------------------------------------------------------------------
// List headers + sets
// ---------------------------------------------------------------------------

function buildListHeader(magic: "mhlt" | "mhlp", headerLen: number, count: number): Buffer {
  const h = header(magic, headerLen);
  h.writeUInt32LE(count, 0x08); // count, NOT a byte length
  return h;
}

export function buildTrackSet(tracks: TrackEntry[], macTime: number): Buffer {
  const items = tracks.map((t) => buildMhit(t, macTime));
  const list = Buffer.concat([buildListHeader("mhlt", MHLT_HEADER_LEN, tracks.length), ...items]);
  return buildMhsd(MhsdType.Tracks, list);
}

export function buildPlaylistSet(playlists: PlaylistEntry[]): Buffer {
  const items = playlists.map(buildMhyp);
  const list = Buffer.concat([buildListHeader("mhlp", MHLP_HEADER_LEN, playlists.length), ...items]);
  return buildMhsd(MhsdType.Playlists, list);
}

function buildMhsd(type: number, list: Buffer): Buffer {
  const h = header("mhsd", MHSD_HEADER_LEN);
  h.writeUInt32LE(MHSD_HEADER_LEN + list.length, 0x08); // total length
  h.writeUInt32LE(type, 0x0c);
  return Buffer.concat([h, list]);
}

// ---------------------------------------------------------------------------
// mhbd — top level
// ---------------------------------------------------------------------------

/** Serialize a whole database to bytes. */
export function serializeItunesDb(model: ItunesDbModel, opts: SerializeOptions = {}): Buffer {
  const macTime = opts.macTime ?? toMacTime();
  const sets = [buildTrackSet(model.tracks, macTime), buildPlaylistSet(model.playlists)];
  const body = Buffer.concat(sets);

  const h = header("mhbd", MHBD_HEADER_LEN);
  h.writeUInt32LE(MHBD_HEADER_LEN + body.length, 0x08); // total file length
  h.writeUInt32LE(1, 0x0c); // unknown1
  h.writeUInt32LE(DB_VERSION, 0x10);
  h.writeUInt32LE(sets.length, 0x14); // number of mhsd children
  h.writeBigUInt64LE(opts.libraryPersistentId ?? 0n, 0x18);
  return Buffer.concat([h, body]);
}

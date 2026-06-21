/**
 * Minimal old-format iTunesDB reader.
 *
 * v0.1 uses this for tests only: it validates the serializer's output and lets us
 * structurally diff against the real iTunes-written DB (the correctness oracle). It is
 * built clean so the parent project's Phase 2 smart-sync can reuse it to match tracks
 * by their Plex ratingKey. It extracts only what those callers need — track id,
 * location, comment, the descriptive strings, and playlist membership — NOT full
 * round-trip fidelity. It never participates in any wipe/delete path.
 *
 * The reader is tolerant of chunks podscribe does not write (album lists, podcast
 * sets, extra mhods): it advances by each chunk's declared length and ignores
 * anything it does not recognize.
 */

import { MhodType, MhsdType } from "./itunesdb.js";

export interface ReadTrack {
  id: number;
  title?: string;
  artist?: string;
  album?: string;
  genre?: string;
  comment?: string;
  /** Colon-separated on-iPod path from the location mhod. */
  location?: string;
}

export interface ReadPlaylist {
  name?: string;
  isMaster: boolean;
  trackIds: number[];
}

export interface ReadDb {
  version: number;
  tracks: ReadTrack[];
  playlists: ReadPlaylist[];
}

const MHOD_STRING_TYPES = new Set<number>([
  MhodType.Title,
  MhodType.Location,
  MhodType.Album,
  MhodType.Artist,
  MhodType.Genre,
  MhodType.Filetype,
  MhodType.Comment,
]);

function magicAt(buf: Buffer, off: number): string {
  return buf.toString("ascii", off, off + 4);
}

/** Pull the ratingKey out of a `PLEXID:<ratingKey>` comment, or undefined. */
export function parsePlexRatingKey(comment: string | undefined): string | undefined {
  if (!comment) return undefined;
  const m = /^PLEXID:(.+)$/.exec(comment.trim());
  return m ? m[1] : undefined;
}

/** Parse one mhod and return its type and (for string mhods) decoded value. */
function readMhod(buf: Buffer, off: number): { type: number; value?: string } {
  const type = buf.readUInt32LE(off + 0x0c);
  if (MHOD_STRING_TYPES.has(type)) {
    const len = buf.readUInt32LE(off + 0x1c); // byte length
    const value = buf.toString("utf16le", off + 0x28, off + 0x28 + len);
    return { type, value };
  }
  return { type };
}

function readMhit(buf: Buffer, off: number): ReadTrack {
  const headerLen = buf.readUInt32LE(off + 0x04);
  const numMhods = buf.readUInt32LE(off + 0x0c);
  const track: ReadTrack = { id: buf.readUInt32LE(off + 0x10) };

  let p = off + headerLen;
  for (let i = 0; i < numMhods; i++) {
    const totalLen = buf.readUInt32LE(p + 0x08);
    const { type, value } = readMhod(buf, p);
    switch (type) {
      case MhodType.Title:
        track.title = value;
        break;
      case MhodType.Artist:
        track.artist = value;
        break;
      case MhodType.Album:
        track.album = value;
        break;
      case MhodType.Genre:
        track.genre = value;
        break;
      case MhodType.Comment:
        track.comment = value;
        break;
      case MhodType.Location:
        track.location = value;
        break;
    }
    p += totalLen;
  }
  return track;
}

function readMhyp(buf: Buffer, off: number): ReadPlaylist {
  const headerLen = buf.readUInt32LE(off + 0x04);
  const numMhods = buf.readUInt32LE(off + 0x0c);
  const numMhips = buf.readUInt32LE(off + 0x10);
  const isMaster = buf.readUInt32LE(off + 0x14) === 1;
  const playlist: ReadPlaylist = { isMaster, trackIds: [] };

  let p = off + headerLen;
  // The title (and any other mhods) come first.
  for (let i = 0; i < numMhods; i++) {
    const totalLen = buf.readUInt32LE(p + 0x08);
    const { type, value } = readMhod(buf, p);
    if (type === MhodType.Title && playlist.name === undefined) playlist.name = value;
    p += totalLen;
  }
  // Then one mhip per track.
  for (let i = 0; i < numMhips; i++) {
    const totalLen = buf.readUInt32LE(p + 0x08);
    playlist.trackIds.push(buf.readUInt32LE(p + 0x18));
    p += totalLen;
  }
  return playlist;
}

/** Parse an old-format iTunesDB buffer into the minimal model the project needs. */
export function readItunesDb(buf: Buffer): ReadDb {
  if (magicAt(buf, 0) !== "mhbd") throw new Error("not an iTunesDB: missing mhbd magic");

  const mhbdHeaderLen = buf.readUInt32LE(0x04);
  const version = buf.readUInt32LE(0x10);
  const numSets = buf.readUInt32LE(0x14);

  const db: ReadDb = { version, tracks: [], playlists: [] };

  let setOff = mhbdHeaderLen;
  for (let s = 0; s < numSets; s++) {
    if (magicAt(buf, setOff) !== "mhsd")
      throw new Error(`expected mhsd at 0x${setOff.toString(16)}, got ${magicAt(buf, setOff)}`);
    const setHeaderLen = buf.readUInt32LE(setOff + 0x04);
    const setTotalLen = buf.readUInt32LE(setOff + 0x08);
    const setType = buf.readUInt32LE(setOff + 0x0c);

    const listOff = setOff + setHeaderLen;
    const listHeaderLen = buf.readUInt32LE(listOff + 0x04);
    const count = buf.readUInt32LE(listOff + 0x08);

    let itemOff = listOff + listHeaderLen;
    if (setType === MhsdType.Tracks && magicAt(buf, listOff) === "mhlt") {
      for (let i = 0; i < count; i++) {
        const track = readMhit(buf, itemOff);
        db.tracks.push(track);
        itemOff += buf.readUInt32LE(itemOff + 0x08); // mhit total length
      }
    } else if (
      (setType === MhsdType.Playlists || setType === MhsdType.Podcasts) &&
      magicAt(buf, listOff) === "mhlp"
    ) {
      for (let i = 0; i < count; i++) {
        const playlist = readMhyp(buf, itemOff);
        db.playlists.push(playlist);
        itemOff += buf.readUInt32LE(itemOff + 0x08); // mhyp total length
      }
    }
    // Other set types (album list, etc.) are skipped via setTotalLen.

    setOff += setTotalLen;
  }
  return db;
}

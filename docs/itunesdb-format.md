# Old-format iTunesDB byte layout

This is the exact on-disk layout `podscribe` writes for a 5.5-gen iPod Video (A1136).
All integers are **little-endian**. There is **no checksum / hash58** in this format —
the firmware accepts the bytes as-is.

Every offset below was confirmed by decoding the user's real iTunes-written `iTunesDB`
(529 tracks, 7 playlists) — the correctness oracle. See `test/itunesdbReader.test.ts`,
which re-parses that file when present.

## Two kinds of chunk

Every chunk starts with a 4-byte ASCII magic and a 4-byte header length. The third
field differs by chunk family:

| Family | Examples | Field at 0x08 | Meaning |
|--------|----------|---------------|---------|
| **container / item** | mhbd, mhsd, mhit, mhod, mhyp, mhip | total length | bytes of this chunk **including** all children |
| **list header** | mhlt, mhlp | child count | number of sibling items that follow it |

A list header has no total-length field. Its parent (an mhsd) carries the byte size;
the list header only says "N items follow me, each starting after my header".

The tree, for the minimal database podscribe writes:

```
mhbd  (database header)
 ├ mhsd type=1   (track set)
 │   └ mhlt  (track list header, count = N tracks)
 │       └ mhit ×N  (track item)
 │           └ mhod ×M  (title, artist, album, genre, filetype, comment, location)
 └ mhsd type=2   (playlist set)
     └ mhlp  (playlist list header, count = P playlists)
         └ mhyp ×P  (playlist; one is the master/library playlist, flag=1)
             ├ mhod      (playlist title)
             └ mhip ×K   (playlist item → references a track by id)
                 └ mhod type=100  (playlist position index)
```

> The real iTunes DB also writes mhsd type=3 (podcasts), type=4 (album list / mhla)
> and type=5. The firmware does not require them to display a flat track list and named
> playlists, so podscribe omits them in v0.1.

## mhbd — database header (header length 0xF4)

| Offset | Size | Field | Value podscribe writes |
|--------|------|-------|------------------------|
| 0x00 | 4 | magic | `mhbd` |
| 0x04 | 4 | header length | 0xF4 (244) |
| 0x08 | 4 | total length | whole file size |
| 0x0C | 4 | unknown1 | 1 |
| 0x10 | 4 | version | 0x19 (see note) |
| 0x14 | 4 | number of mhsd children | 2 |
| 0x18 | 8 | library persistent id | stable per device (injectable) |
| rest | — | hash / unknown | zero (no checksum on A1136) |

> **Version field:** the oracle DB (written by a modern iTunes) carries 0x75 here and
> the firmware reads it. libgpod historically wrote 0x13–0x19 and those also display.
> podscribe uses 0x19; the on-device test in M4 is the final arbiter.

## mhsd — set container (header length 0x60)

| Offset | Size | Field |
|--------|------|-------|
| 0x00 | 4 | magic `mhsd` |
| 0x04 | 4 | header length 0x60 |
| 0x08 | 4 | total length (header + the one list it contains) |
| 0x0C | 4 | type: 1 = tracks, 2 = playlists, 3 = podcasts |

## mhlt / mhlp — list headers (header length 0x5C)

| Offset | Size | Field |
|--------|------|-------|
| 0x00 | 4 | magic `mhlt` (tracks) or `mhlp` (playlists) |
| 0x04 | 4 | header length 0x5C |
| 0x08 | 4 | **count** of items that follow |

## mhit — track item (header length 0x9C)

Children (mhod) follow the header. Confirmed offsets:

| Offset | Size | Field | Notes |
|--------|------|-------|-------|
| 0x00 | 4 | magic `mhit` | |
| 0x04 | 4 | header length | 0x9C (156) |
| 0x08 | 4 | total length | header + all mhods |
| 0x0C | 4 | number of mhods | |
| 0x10 | 4 | track id | ephemeral, 1..N at serialize time |
| 0x14 | 4 | visible | 1 |
| 0x18 | 4 | filetype fourcc | optional; 0 is accepted |
| 0x20 | 4 | last-modified time | Mac timestamp (secs since 1904-01-01) |
| 0x24 | 4 | file size | bytes |
| 0x28 | 4 | length | milliseconds |
| 0x2C | 4 | track number | |
| 0x30 | 4 | total tracks | |
| 0x34 | 4 | year | |
| 0x38 | 4 | bitrate | kbps |
| 0x3C | 4 | sample rate | stored as `rate << 16` |
| 0x68 | 4 | date added | Mac timestamp |

All other header bytes are zero.

## mhod — data object

Base header is 0x18 (24) bytes; the body that follows depends on type.

| Offset | Size | Field |
|--------|------|-------|
| 0x00 | 4 | magic `mhod` |
| 0x04 | 4 | header length 0x18 |
| 0x08 | 4 | total length (header + body) |
| 0x0C | 4 | type |

### String mhod (types 1 title, 2 location, 3 album, 4 artist, 5 genre, 6 filetype, 8 comment)

A 16-byte sub-header follows the base header, then the UTF-16LE string:

| Offset | Size | Field |
|--------|------|-------|
| 0x18 | 4 | position / flag | 1 |
| 0x1C | 4 | string length in **bytes** |
| 0x20 | 4 | encoding | 1 = UTF-16LE |
| 0x24 | 4 | unknown | 0 |
| 0x28 | … | string data (UTF-16LE, no NUL terminator) |

Total length = 0x28 + byteLength(string).

> **Location** (type 2) is just a string mhod whose value is the colon-separated
> on-iPod path, e.g. `:iPod_Control:Music:F07:ABCD.mp3`.

### Position mhod (type 100, inside an mhip)

Total length 0x2C. Base header, then the playlist position as a uint32 at 0x18; the
remaining bytes are zero.

## mhyp — playlist (header length 0xB8)

| Offset | Size | Field |
|--------|------|-------|
| 0x00 | 4 | magic `mhyp` |
| 0x04 | 4 | header length 0xB8 (184) |
| 0x08 | 4 | total length |
| 0x0C | 4 | number of mhods (the title) |
| 0x10 | 4 | number of mhips (tracks) |
| 0x14 | 4 | is-master-playlist flag (1 for the library playlist) |

Children: first the title mhod (type 1), then one mhip per track.

> **Master playlist is mandatory.** A track that is not in the master/library playlist
> (mhyp flag = 1) does not appear in the old-format UI even if its mhit exists.

## mhip — playlist item (header length 0x4C)

| Offset | Size | Field |
|--------|------|-------|
| 0x00 | 4 | magic `mhip` |
| 0x04 | 4 | header length 0x4C (76) |
| 0x08 | 4 | total length (header + position mhod) |
| 0x0C | 4 | number of mhods | 1 (the position mhod) |
| 0x10 | 4 | podcast grouping | 0 |
| 0x14 | 4 | group id | playlist position |
| 0x18 | 4 | **track id** | links this item to an mhit |

Child: one position mhod (type 100).

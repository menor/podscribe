# podscribe

A small, legible TypeScript library that writes the **old-format iTunesDB** for the
5.5-generation iPod Video (A1136) — the database with **no hash58/checksum**. It manages the
iPod's tracks, playlists, and audio files, reimplemented from the documented binary format.

It's the minimum slice of [libgpod](https://github.com/libgpod/libgpod) this needs, rebuilt in
TypeScript because libgpod is no longer packaged for modern macOS and no maintained iTunesDB
*writer* exists in any language.

> **Status:** pre-v0.1, in active development. The serializer and iPod operations are being
> built and verified against a real iTunes-generated database before any on-device trust.

## Why

- **No libgpod path left.** It's gone from Homebrew (no formula/tap/cask/pip); every route now
  means a from-source autotools build of a 2012 C library on macOS 14.
- **Reimplementation is unavoidable** regardless of language — no library *writes* an iTunesDB.
- The target iPod uses the **old format with no checksum**, so the hard, signature-forging part
  of modern iPod support doesn't apply. It's plain little-endian `Buffer` serialization on a
  mounted FAT32 volume — no native USB, no kernel access.

## Scope

**In:** iTunesDB chunk serialization; reading MP3 tags (read-only); copying audio into
`iPod_Control/Music`; create/fetch/modify playlists including the master playlist; full wipe;
safe save with `fsync` + OS sync + loud safe-to-eject; timestamped backup. A minimal chunk-tree
**reader** used to validate the writer against a real database.

**Out:** Plex, networking, smart-sync diffing, transcoding, and modern (hashed) DB formats.

## Planned API

```ts
openIpod(mountPath): IpodDb            // locate iPod_Control
backupDb(db): string                   // timestamped copy, returns path
addTrack(db, filePath, { comment? }): Track
getOrCreatePlaylist(db, name): Playlist
addToPlaylist(pl, track) / removeFromPlaylist / reorderPlaylist(pl, trackIds[])
wipeAll(db, { confirm: true })         // mirror: drop all tracks/playlists + audio
save(db)                               // serialize, write, fsync, OS sync, eject notice
```

## Format

Old-format iTunesDB chunk tree (little-endian, no checksum):

```
mhbd                       database header
 └ mhsd type=1             tracklist set
    └ mhlt                 track list header (count)
       └ mhit ×N           track item
          └ mhod ×M        data objects: title, artist, album, comment, filepath, …
 └ mhsd type=2/3           playlist set
    └ mhlp                 playlist list header (count)
       └ mhyp ×P           playlist (index 1 = master/library)
          ├ mhod           playlist title
          └ mhip ×K → mhod playlist item → references a track by id
```

A track must be added to the master/library playlist (`mhyp` index 1), not only the named one,
or the old-format firmware won't display it.

## Safety

- **Never** modifies source music files or their tags — tags are read-only inputs.
- **Always** backs up the existing iTunesDB (timestamped, never overwriting) before any write.
- Operates only on a properly-mounted FAT32 iPod; `save` flushes, `fsync`s, OS-syncs, and prints
  a loud safe-to-eject notice.
- Fails loudly — names which track failed and why.

## License

[MIT](LICENSE) © 2026 José Menor

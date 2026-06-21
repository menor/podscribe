# On-device acceptance test (M4.11)

This is the v0.1 gate. podscribe is "done" only when a playlist written by `ipod-add`
appears on the physical 5.5-gen iPod (A1136) and plays. The order below is strict: the
backup happens **before** any deletion, and deletion is **manual** (the file-deleting
`wipeAll` is deferred until the writer is proven).

## Before you start

- A 5.5-gen iPod Video, **FAT32 ("Windows") formatted**. `ipod-add` refuses an HFS+ device.
- 3–4 short MP3s with real ID3 tags (title/artist/album). Tags prove the firmware reads
  the strings, not just that audio plays.
- The iPod mounted. On macOS it appears at `/Volumes/<NAME>`.

## Steps

1. **Back up + capture the oracle (before any delete).**
   Copy `iPod_Control/iTunes/iTunesDB` off the device and keep it. It is both the safety
   backup and the correctness oracle. `ipod-add` also takes its own timestamped backup at
   write time, but copy it yourself first too.

2. **Delete existing audio manually in Finder.**
   Remove everything under `iPod_Control/Music/F00 … F49`. Hidden macOS files
   (`.Spotlight`, `._*`) are firmware-ignored — leave them. An empty `Music/` plus a fresh
   DB means zero orphans. Do **not** use any podscribe delete command (there isn't one yet).

3. **Write the test playlist.**

   ```
   npx tsx src/cli/ipod-add.ts \
     --mount /Volumes/IPOD \
     --playlist "LIBGPOD TEST" \
     --files track1.mp3 track2.mp3 track3.mp3
   ```

   The CLI verifies FAT32, backs up the (now-fresh) DB, copies each MP3 into
   `Music/F00..`, joins them to "LIBGPOD TEST" and the master playlist, then writes and
   fsyncs the DB. It prints a loud "safe to eject" line when done.

4. **Eject and verify.**
   Eject the iPod in Finder (wait for the line to clear). Unplug. On the device, open
   Playlists → **LIBGPOD TEST**. Confirm the tracks show correct title/artist and play.

> [CHECKPOINT] STOP here. Report whether "LIBGPOD TEST" appears and plays. That confirms
> the writer end-to-end and unblocks ipod-mixtapes Phase 2.

## If it fails

- Nothing shows at all → the DB likely wasn't accepted. Diff the bytes against the oracle
  you captured in step 1; suspects are the mhbd version field (0x19 vs the oracle's 0x75)
  and the minimal mhsd set (types 1+2 only). These are the two known open risks.
- Tracks show but won't play → the audio copy or path mapping is wrong, not the DB.
- Restore: copy your step-1 backup back to `iPod_Control/iTunes/iTunesDB`.

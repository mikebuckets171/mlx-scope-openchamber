# Draw Things CLI fixture corpus

**Version represented:** `draw-things-cli` 26.10 (Homebrew 26.0928.0 and the unpacked 26.1011.0 build), captured on
2026-10-19 from renders that had already finished on the author's Mac. No render was started for these fixtures.

Each file is the CLI's own standard output, redirected to a file as a render script does, byte for byte (carriage
returns and terminal escapes kept). Only two kinds of line held anything private, and both were replaced: the
`Models directory:` path, and the `Wrote:` output path, which is now the canary `/Users/fixture/private/FIXTURE PRIVATE
RENDER.<ext>` that the tests require never to leave the adapter. The CLI prints no prompt or settings.

- `video-completed.txt` — a 25-step video render through `Generated` and `Wrote: ….mp4`, with its timing summary.
- `image-completed.txt` — an 8-step image render through `Wrote: ….png`.
- `image-stopped.txt` — a 40-step image render that ended at step 32 with no further line (stopped from outside).

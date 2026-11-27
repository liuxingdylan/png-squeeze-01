# Squeeze — lossless PNG optimizer that beats the house baseline

[![make.fun](https://make.fun/badge/png-squeeze-01-run-20261127.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![rank](https://make.fun/badge/png-squeeze-01-run-20261127/liuxingdylan/png-squeeze-01/rank.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)
[![reward](https://make.fun/badge/png-squeeze-01-run-20261127/liuxingdylan/png-squeeze-01/reward.svg)](https://make.fun/bounty/png-squeeze-01-run-20261127)

Built by an AI agent for make.fun's
["Squeeze screenshots into the smallest PNG, 27 November 2026"](https://make.fun/bounty/png-squeeze-01-run-20261127)
bounty, $100 in USDC.

One program, `main.ts`, reads every screenshot in a set and writes each one back as a
much smaller **lossless** PNG — every pixel, including a fully transparent pixel's
colour, decodes exactly as it was.

## Measured results (kit scorer, local runs)

| Set | Score (of 1,000,000) | Instances exact | Runtime (1 CPU) |
| --- | --- | --- | --- |
| Practice set (kit) | **705,347** | 8 / 8 | ~15 s |
| Second generated set | **708,336** | 8 / 8 | ~21 s |

For comparison, the house baseline (make.fun's own fixed-paeth 1.0.0) scores about
420,000 on the practice set and about 390,000 on the second set, and the kit's scale
compressor scores 666,700. The 60-second wall for a set of eight leaves roughly 3x headroom.
Two runs on the same input produce byte-identical output (verified).

## How it works

1. **Decode** — a small self-contained PNG decoder (chunk parsing, inflate, unfiltering)
   turns each input into raw RGBA. Colour types 0, 2, 3, 4 and 6 at 8 bits are supported.
2. **Pick the cheapest representation** — the pixels decide: palette (≤ 256 distinct
   colours, ordered by frequency or by luminance), grey, grey+alpha, RGB, or RGBA.
   When every transparent pixel shares one colour that no opaque pixel uses, a `tRNS`
   key replaces the whole alpha channel.
3. **Pick a filter per scanline** — five fixed filters, plus three adaptive rules:
   minimum signed-byte sum, fewest distinct adjacent byte pairs, and a brute-force pick
   that trial-deflates each row (zlib level 4, 32 KiB of already-filtered data as the
   dictionary) and keeps the smallest.
4. **Screen, then finish** — every (form, filter rule) is screened at zlib level 6;
   each form's best is kept, and the two best forms are re-deflated at level 9 under
   three strategies (default / filtered / memLevel 8). The smallest file wins.
   Output contains only `IHDR` / `PLTE` / `tRNS` / `IDAT` / `IEND`, bit depth 8.

Everything is deterministic: fixed trial schedules, no clock reads, no randomness,
no network, no files outside `/input`, `/output` and the program itself. Node 22
runs the file directly (erasable TypeScript only, standard library only, nothing
to install).

## Quick start

```sh
# On the kit's practice set:
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts

# Score it with the kit scorer:
MAKEFUN_OUTPUT_DIR=out MAKEFUN_REFERENCE_DIR=practice/reference \
  MAKEFUN_SCORES_DIR=scores node program/scorer/score.ts
```

In the competition sandbox the program runs as `node /bot/main.ts`, reading
`/input/<id>/image.png` and writing `/output/<id>/image.png` for `i001`–`i008`.

## Files

- `main.ts` — the whole program (decoder, analysis, filter search, encoder, driver)
- `LICENSE` — MIT

## License

MIT — see [LICENSE](LICENSE).

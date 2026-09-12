# dotimg

Compress any image, video, GIF, music or audio file down to a file size you name, in the
browser. Nothing is uploaded: decoding and encoding happen on the machine that opens the page.

## Running it locally

Double click `start.bat`, or serve the folder any other way:

```bash
python -m http.server 8137
```

Then open http://localhost:8137. It must be served over `http://`, not opened as a `file://`
path, because the page uses ES modules and a web worker.

## Using it

One file at a time. Choose a file, or drop it on the page, or paste it. The page works out what
it is and offers only the formats that belong to the same family, so music converts to music,
video to video, and a picture to a picture. Type a target size, pick a unit from bytes to
gigabytes, and press Compress.

The target is a ceiling, not a goal. A file already under it is left untouched, and a result is
never larger than the file that went in.

The page is deliberately plain: no stylesheet at all, just browser defaults.

## Supported formats

Every extension below was generated as a real file and run through the pipeline.

| Detected as | Reads | Converts to |
| --- | --- | --- |
| Music or audio | `.mp3` `.wav` `.aac` `.flac` `.ogg` `.m4a` `.wma` `.alac` `.aiff` `.opus` | the same ten |
| MIDI | `.mid` | MIDI only |
| Still picture | `.jpg` `.jpeg` `.png` `.bmp` `.webp` `.tiff` `.svg` `.ico` | JPEG, PNG, WebP, AVIF, GIF, BMP, TIFF, ICO |
| Animation | `.gif`, animated `.webp` and `.png` | GIF, MP4, WebM, MKV, MOV, AVI |
| Video | `.mp4` `.m4v` `.mov` `.avi` `.mkv` `.webm` `.flv` `.wmv` `.3gp` `.mpeg` `.ogv` | MP4, WebM, MKV, MOV, AVI |
| Refused, with a reason | `.heic` `.raw` | nothing |

A MIDI file can only stay MIDI. It stores notes rather than sound, so turning it into MP3 would
need a synthesiser, and going the other way would need transcription. SVG is read but never
written, because a drawing cannot be rebuilt once it is flattened into pixels. AVIF is offered
only when the browser can encode it.

## What it does

**Images** are decoded by the browser, so every still format it reads is accepted. The encoder
measures one encode, predicts the scale that would hit the target, and re-measures. It holds
quality at 62 or above and shrinks the frame rather than smearing the picture, dropping below
that floor only when the target leaves no choice. Formats the browser cannot open, such as TIFF,
are decoded by FFmpeg first. GIF, BMP, TIFF and ICO cannot be written by a canvas either, so
each measurement in the search goes out to FFmpeg as a PNG and comes back in the real format.
Those four store pixels more or less as they are, so they need much smaller dimensions than JPEG
or WebP to reach the same target.

**Video** goes through FFmpeg compiled to WebAssembly. The target becomes a bitrate budget from
the real duration; audio gets a floor of its own or is dropped when the budget is too thin, and
resolution and frame rate fall when there are not enough bits per pixel. The encode repeats with
a corrected bitrate until the output lands under the target.

**Music and audio** are bitrate targeted the same way for the lossy codecs, dropping to mono and
a lower sample rate as the budget tightens, with each rate snapped to one its encoder actually
accepts. The lossless formats have no bitrate knob, so sample rate, channels and bit depth are
ranked by fidelity and binary searched instead.

**Animations** are rebuilt with a generated palette. Width, frame rate and palette size are
ranked by how good each combination looks, and a binary search over that ranking finds the best
one that fits.

**MIDI** is a score rather than a recording, so FFmpeg cannot read it and there is no codec to
turn down. The file is parsed and rewritten: text and names first, then note-offs re-expressed
as zero velocity note-ons so running status compresses the whole file, then aftertouch, pitch
bend and controllers, then timing resolution, and only then musical detail. It thins notes but
never returns a silent file.

## Limits

- WebM is offered but is not dependable here. Its only codecs are VP8, VP9 and AV1, and the
  bundled libvpx wants more heap than this single-threaded FFmpeg build can grow to: it encodes
  a 64 pixel frame and runs out of memory at 160. When that happens the page says so and points
  at MP4, MKV, MOV or AVI, which all work.
- HEIC needs Apple's decoder, so it works in Safari and nowhere else; the bundled FFmpeg has no
  HEIF support. Camera RAW differs per manufacturer and is not developed either. Both are
  refused with an explanation, not a silent failure.
- Every format has a size floor from its own headers. In Chrome that is roughly 760 bytes for
  JPEG and 540 for WebP no matter how small the picture, which is why PNG is used for targets
  under a few kilobytes. Lossy audio encoders have a minimum bitrate, so a tiny target on a long
  track cannot be met. In each case the page reports the floor and offers the smallest file it
  managed.
- FFmpeg here is the single-threaded build, so it needs no special server headers but encodes at
  maybe a quarter of native speed. Long videos take minutes.
- Its heap grows with every run and never fully returns it, so a long session can eventually
  trap. The engine restarts itself and the page quietly tries the same job once more, so this is
  usually invisible.
- DRM-protected media cannot be read at all.

## Deploying it

`vendor/core/ffmpeg-core.wasm` is 32 MB, which is over the 25 MB per-file limit on
Cloudflare Pages and several other static hosts, so it is gitignored and never uploaded.
The page checks for it at load: when the file really is there it is used, and when it is
missing the identical build is fetched from `cdn.jsdelivr.net` instead. That is why the
site works locally, where the file exists on disk, and also works deployed, where it does
not.

Getting this wrong is what produces `CompileError: WebAssembly.instantiate(): BufferSource
argument is empty`: the browser downloaded a 404 page instead of the binary.

If you would rather not depend on the CDN, host the file somewhere with no size limit and
point `CORE_WASM_CDN` in `media-engine.js` at it. It must be the `@ffmpeg/core@0.12.6`
build, because the loader beside it is that version and the two must match.

## Layout

| File | Role |
| --- | --- |
| `index.html` | The whole page, about 80 lines, with no stylesheet |
| `app.js` | File typing, the format lists, routing and UI wiring |
| `image-engine.js` | Still-image scale and quality search |
| `media-engine.js` | FFmpeg loading and recycling, video, audio and GIF searches |
| `midi-engine.js` | MIDI parser, rewriter and reduction ladder |
| `vendor/` | FFmpeg WebAssembly build; the 32 MB core is gitignored and falls back to a CDN |

`vendor/` is a copy of `@ffmpeg/ffmpeg` 0.12.10 and `@ffmpeg/core` 0.12.6. The JavaScript is
served from this origin because browsers refuse to start a worker from a cross-origin script.
The 32 MB core binary is the one exception, for the size reason above.

## Source and donations

Source code: https://github.com/onononoo/dotimg

this project is open source, so please donate to keep it up :) ! btc: bc1qs4z04ltddh6vaqd4stu3p4vekv253ht4cwqma4

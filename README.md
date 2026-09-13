# dotimg, runs completely in **your** browser.

compress any image, video, gif, music, audio, data, table, subtitle or code file down to a file
size you name, in the browser. nothing is uploaded: decoding and encoding happen on the machine that opens the page.

## running it locally

double click `start.bat`, or serve the folder any other way:

```bash
python -m http.server 8137
```

then open http://localhost:8137. it must be served over `http://`, not opened as a `file://`
path, because the page uses es modules and a web worker.

## using it

one file at a time. choose a file, or drop it on the page, or paste it. the page works out what
it is and offers only the formats that belong to the same family, so music converts to music,
video to video, and a picture to a picture. type a target size, pick a unit from bytes to
gigabytes, and press compress.

the target is a ceiling, not a goal. a file already under it is left untouched, and compressing
a file into its own format never makes it larger. the one exception is converting a lossless
file into a close relative, such as tsv into csv, which can legitimately come out a little
larger; there only your target applies.

## supported formats

every extension below was generated as a real file and run through the pipeline.

| detected as | reads | converts to |
| --- | --- | --- |
| music or audio | `.mp3` `.wav` `.aac` `.flac` `.ogg` `.m4a` `.wma` `.alac` `.aiff` `.opus` | the same ten |
| midi | `.mid` | midi only |
| still picture | `.jpg` `.jpeg` `.png` `.bmp` `.webp` `.tiff` `.svg` `.ico` | jpeg, png, webp, avif, gif, bmp, tiff, ico |
| animation | `.gif`, animated `.webp` and `.png` | gif, mp4, webm, mkv, mov, avi |
| video | `.mp4` `.m4v` `.mov` `.avi` `.mkv` `.webm` `.flv` `.wmv` `.3gp` `.mpeg` `.ogv` | mp4, webm, mkv, mov, avi |
| structured data | `.json` `.yaml` `.yml` | json, yaml |
| table | `.csv` `.tsv` | csv, tsv |
| subtitles | `.srt` `.vtt` | srt, vtt |
| code | `.js` `.mjs` `.css` `.html` `.htm` `.xml` | its own format, minified |
| plain text | `.txt` `.md` | its own format |
| refused, with a reason | `.heic` `.raw`, and any type dotimg does not know | nothing |

svg can stay svg, minified, or be flattened into any of the picture formats. the reverse is not
possible: a picture made of pixels cannot be rebuilt into a drawing.

a midi file can only stay midi. it stores notes rather than sound, so turning it into mp3 would
need a synthesiser, and going the other way would need transcription. avif is offered only when
the browser can encode it.

## what it does

**images** are decoded by the browser, so every still format it reads is accepted. the encoder
measures one encode, predicts the scale that would hit the target, and re-measures. it holds
quality at 62 or above and shrinks the frame rather than smearing the picture, dropping below
that floor only when the target leaves no choice. formats the browser cannot open, such as tiff,
are decoded by ffmpeg first. gif, bmp, tiff and ico cannot be written by a canvas either, so
each measurement in the search goes out to ffmpeg as a png and comes back in the real format.
those four store pixels more or less as they are, so they need much smaller dimensions than jpeg
or webp to reach the same target.

**video** goes through ffmpeg compiled to webassembly. the target becomes a bitrate budget from
the real duration; audio gets a floor of its own or is dropped when the budget is too thin, and
resolution and frame rate fall when there are not enough bits per pixel. the encode repeats with
a corrected bitrate until the output lands under the target.

**music and audio** are bitrate targeted the same way for the lossy codecs, dropping to mono and
a lower sample rate as the budget tightens, with each rate snapped to one its encoder actually
accepts. the lossless formats have no bitrate knob, so sample rate, channels and bit depth are
ranked by fidelity and binary searched instead.

**animations** are rebuilt with a generated palette. width, frame rate and palette size are
ranked by how good each combination looks, and a binary search over that ranking finds the best
one that fits.

**text, code and data** are lossless: nothing in them can be removed without changing what
they mean, so each has a floor, and the page says so when your target is below it. json and
yaml are parsed and rewritten, trying both yaml layouts and keeping the smaller. tables go
through papaparse, so a quoted field containing a comma survives, and cells stay text, so a
code like 007 keeps its zeros. subtitles are parsed by hand, keeping every cue and timestamp.
javascript goes through terser, css through csso, and html through html-minifier-terser,
never simple whitespace stripping, which breaks code in subtle ways. licence comments in
javascript are kept. xml keeps same-line spaces between elements, since in mixed content they
are part of the text, and removes only indentation. only utf-8 text is rewritten: anything
else is refused, so nothing in another encoding is silently corrupted. converting to a close
relative, such as tsv to csv, may legitimately come out a little larger, and that is allowed.

**midi** is a score rather than a recording, so ffmpeg cannot read it and there is no codec to
turn down. the file is parsed and rewritten: text and names first, then note-offs re-expressed
as zero velocity note-ons so running status compresses the whole file, then aftertouch, pitch
bend and controllers, then timing resolution, and only then musical detail. it thins notes but
never returns a silent file.

## limits

- webm is offered but is not dependable here. its only codecs are vp8, vp9 and av1, and the
  bundled libvpx wants more heap than this single-threaded ffmpeg build can grow to: it encodes
  a 64 pixel frame and runs out of memory at 160. when that happens the page says so and points
  at mp4, mkv, mov or avi, which all work.
- heic needs apple's decoder, so it works in safari and nowhere else; the bundled ffmpeg has no
  heif support. camera raw differs per manufacturer and is not developed either. both are
  refused with an explanation, not a silent failure.
- every format has a size floor from its own headers. in chrome that is roughly 760 bytes for
  jpeg and 540 for webp no matter how small the picture, which is why png is used for targets
  under a few kilobytes. lossy audio encoders have a minimum bitrate, so a tiny target on a long
  track cannot be met. in each case the page reports the floor and offers the smallest file it
  managed.
- ffmpeg here is the single-threaded build, so it needs no special server headers but encodes at
  maybe a quarter of native speed. long videos take minutes.
- its heap grows with every run and never fully returns it, so a long session can eventually
  trap. the engine restarts itself and the page quietly tries the same job once more, so this is
  usually invisible.
- drm-protected media cannot be read at all.
- xml cannot say on its own which whitespace matters. dotimg keeps anything on a single line and
  removes only indentation, so xhtml whose meaning depends on line breaks between elements is
  better minified as html.
- yaml comments are not kept, and converting webvtt to srt drops cue positioning and styling,
  since srt has neither. the page says so each time.

## deploying it

`vendor/core/ffmpeg-core.wasm` is 32 mb, which is over the 25 mb per-file limit on
cloudflare pages and several other static hosts, so it is gitignored and never uploaded.
the page checks for it at load: when the file really is there it is used, and when it is
missing the identical build is fetched from `cdn.jsdelivr.net` instead. that is why the
site works locally, where the file exists on disk, and also works deployed, where it does
not.

getting this wrong is what produces `CompileError: WebAssembly.instantiate(): BufferSource
argument is empty`, quoted here exactly as the browser prints it: the browser downloaded a
404 page instead of the binary.

if you would rather not depend on the cdn, host the file somewhere with no size limit and
point `CORE_WASM_CDN` in `media-engine.js` at it. it must be the `@ffmpeg/core@0.12.6`
build, because the loader beside it is that version and the two must match.

## layout

| file | role |
| --- | --- |
| `index.html` | the whole page, about 80 lines, with no stylesheet |
| `app.js` | file typing, the format lists, routing and ui wiring |
| `image-engine.js` | still-image scale and quality search |
| `media-engine.js` | ffmpeg loading and recycling, video, audio and gif searches |
| `midi-engine.js` | midi parser, rewriter and reduction ladder |
| `text-engine.js` | data, table, subtitle, code and plain text rewriting |
| `lib-loader.js` | loads each vendored library once, only when a file needs it |
| `vendor/` | ffmpeg webassembly build; the 32 mb core is gitignored and falls back to a cdn |

`vendor/` is a copy of `@ffmpeg/ffmpeg` 0.12.10 and `@ffmpeg/core` 0.12.6. the javascript is
served from this origin because browsers refuse to start a worker from a cross-origin script.
the 32 mb core binary is the one exception, for the size reason above.

## third-party libraries

all vendored in `vendor/`, pinned to exact versions, and loaded only when a file needs them.

| library | version | licence | used for |
| --- | --- | --- | --- |
| ffmpeg.wasm (`@ffmpeg/ffmpeg`, `@ffmpeg/core`) | 0.12.10, 0.12.6 | mit, lgpl/gpl core | audio, video, animation |
| js-yaml | 4.1.0 | mit | yaml |
| papaparse | 5.4.1 | mit | csv and tsv |
| terser | 5.31.6 | bsd-2-clause | javascript |
| csso | 5.0.5 | mit | css |
| html-minifier-terser | 7.2.0 | mit | html |
| svgo | 3.3.2 | mit | svg |

## source and donations

source code: https://github.com/onononoo/dotimg

this project is open source, so please donate to keep it up :) ! btc: bc1qs4z04ltddh6vaqd4stu3p4vekv253ht4cwqma4
cicada 3301

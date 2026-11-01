# Building activities

How the activities in this compilation are built, and what a new one has to satisfy. The design authority is the
four reference documents, in precedence order on conflict: *Target Units* (content and sequence) → *Activity
Corpus* (what an activity is) → *Pedagogical Knowledge* (`PEDAGOGY.md`: practice, feedback, mastery) →
*Repository — Vision* (product, modality, technical contract). Rule IDs below (`AC-1`, `NA-6`, `F-12` …) refer to
those documents.

## Layout

```
README.md                      the catalog: one row per activity, links that open it
<activity>/index.html          one folder per activity, named by the acts it digitizes (see-trace-letters …)
hear-see-tap-letters/          Hear Letter Name, See Letter, Tap Letter — built on the shared library below
  launcher.html                tutor/tester launcher: phase, units, hand; shows item results
  manifests/<phase>.json       Vision RP-2 manifests
  narration/manifest.json      every spoken line, with its recorded clip in narration/audio/
  README.md                    design notes, error taxonomy, build checklist, workaround audit
shared/                        the shared component library (Vision VZ-8, RP-10)
  css/tokens.css               the compilation's palette and type (the same values the earlier pages inline)
  css/components.css           shell, progress markers, caption, letter cards, replay control, start, completion
  js/components.js             the same as DOM builders; confirmation tone
  js/narration.js              manifest-driven narration player: preload, barge-in, replay, recorded fallback
  js/telemetry.js              item-level results, telemetry_schema v1, postMessage + CustomEvent + buffer
  js/host.js                   launch parameters, run key, resumable state
  js/rng.js                    seeded randomness (reproducible runs, varied order)
  fonts/                       Andika (SIL OFL): single-story a and g, designed for literacy learners
  data/letters-group1.json     Target Units Letter Group 1: names, key words, confusions, shape lines
tools/                         build tooling (Node 22; run `npm install` here once)
  build-narration-manifest.mjs letters.json → narration/manifest.json (every utterance, stable keys)
  generate-narration.mjs       offline neural TTS (Kokoro-82M) → narration/audio/*.mp3 + review table
  check-narration.mjs          build-breaking check: no missing or orphan clips, keys used by code exist
  test/run.mjs                 headless Chromium test: flow, feedback loop, requeue, resume, telemetry
  kokoro/                      tokenizer/config for the TTS model (the weights come from npm at install)
```

The three earlier activities (`see-trace-letters`, `see-trace-name-letters`, `see-match-letters`) predate the
shared library and inline their own copy of the same tokens; new activities build on `shared/` rather than
re-implementing the shell, cards, replay control, narration player or telemetry (`RP-10`).

## Run it locally

Any static server works; opening a page straight from the file system does not, because ES modules and `fetch`
need `http://`.

```sh
npx --yes http-server . -p 8080 -c-1
# http://localhost:8080/hear-see-tap-letters/?phase=guided&units=a,b,c,d,e
# http://localhost:8080/hear-see-tap-letters/launcher.html
```

## The activity contract

**Input** is the launch URL, so a session layer, a tutor's assignment link and the launcher all use the same link:

| Parameter | Meaning |
|---|---|
| `phase` | `model` \| `guided` \| `independent` — exactly one phase per activity (`AC-1`, PEDAGOGY `P-7`) |
| `units` | 3–7 units from the Target Units group the activity declares (`AC-1`, `AC-2`) |
| `pool`, `passes`, `seed`, `hand`, `lines`, `sfx`, `return` | optional; documented in each activity's manifest |

**Output** is telemetry (`RP-3`, PEDAGOGY `R-12`), `telemetry_schema: "v1"`, delivered three ways so any host can
listen: `window.postMessage` to the embedding page, a `CustomEvent` on `window`, and a buffer in `sessionStorage`
that survives an interruption (`AC-5`, `PL-8`). Messages are `{ source: "otherwise-labs-activity", type, payload }`
with `type` one of `activity:start`, `activity:item`, `activity:complete`. Each item carries: unit, phase, attempt,
response mode, options and target position, outcome (`correct` | `incorrect` | `no_response` | `presentation`;
`uncertain` is reserved for speech items), first tap, latency from prompt onset, error class, hint count, scaffold
state, the repair loop (did the child reproduce the correct response; was it done together), whether the item was
requeued, and a convenience flag `eligible_for_mastery` (first attempt, unscaffolded, correct). The session layer
decides mastery; the activity never does (PEDAGOGY `M-1`–`M-3`, Vision `AC-4`, `RP-5`).

**Manifest.** Every activity ships `manifests/<phase>.json` in the Vision `RP-2` schema: corpus entry, target
skill, domain, unit type and group, modalities, response modes and fallbacks, prerequisites, duration estimate,
narration manifest, assets, declared deviations.

## Narration pipeline

Every instruction, prompt and piece of feedback is spoken (`NA-1`), from recorded audio assets rather than browser
speech synthesis (`NA-6`), one complete sentence per asset and never stitched from fragments (`NA-7`), all listed
in a versioned manifest with stable keys (`NA-10`), and all fetched and decoded before the activity starts
(`NA-13`, `PL-7`).

```sh
cd tools && npm install                      # kokoro-js + the Kokoro-82M q8 weights (from npm, ~120 MB), once
npm run narration:manifest                   # rebuild narration/manifest.json from the letter data
npm run narration:generate                   # record any missing clips offline (add -- --force to redo all)
npm run narration:check                      # build-breaking check: missing/orphan clips, keys, wording
```

The generator runs Kokoro-82M v1.0 (Apache-2.0) on the CPU through onnxruntime. No network access is needed at
generation time: the weights come from the `kokoro-q8-shards` package and the tokenizer files live in
`tools/kokoro/`. `narration/generated.json` records, per clip, the exact phoneme string the engine spoke, so
letter-name pronunciation can be reviewed without listening to every clip.

## Tests

```sh
node tools/test/run.mjs                      # headless Chromium (Playwright); add --headed to watch
```

The test drives a scripted learner through the guided, independent and model phases, forces one wrong tap and
one silence, reloads mid-run, and asserts the whole contract (see the file). With the audio clips present it also
verifies that Chromium decodes every preloaded clip.

## Adding the next activity

1. Pick the corpus entry and the Target Units group. Do not invent activities (`FI-2`).
2. Create `<acts>-<units>/` (the naming the catalog already uses) with `index.html`, `activity.js`,
   `manifests/`, `narration/manifest.json`, and a README that runs the Vision §11 build checklist and the
   §12 / PEDAGOGY §14 workaround audit in writing.
3. Build on `shared/`; add to the library when a component is genuinely new.
4. Author every spoken line in the narration manifest (`A-8`: one clause, ≤ 8 words for K–1, imperative, identical
   wording for an identical interaction), record and check the audio, then test headless.
5. Add the row to `README.md`. Cite rule IDs in comments and commit messages so the rationale survives.

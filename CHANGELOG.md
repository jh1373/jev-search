# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- [docs/design/00-why-jev-obsidian.md](docs/design/00-why-jev-obsidian.md): the rationale for the product.
  It records a comprehensive summary of Jev's characteristics and published limitations, why a
  retrieval-first design is required, why Jev and a "second brain" fit together, the goals and explicit
  non-goals, and a mapping from each Jev property to the design decision it justifies.

### Changed

- **ADR-012**: OpenRouter (`POST https://openrouter.ai/api/alpha/decisions`) becomes the first route for
  development and verification, with the TypeSafe API directly second and Vercel AI Gateway third.
  General users are offered OpenRouter and TypeSafe direct. The OpenRouter contract exposes the same
  `DecisionsScoreQuestion` / `DecisionsScoreAnswer` shape already implemented, and additionally allows
  resolved model version verification, actual cost reporting through `usage.cost`, provider pinning, and a
  zero data retention requirement.
- Design documents 02, 04, 06, 07, and 08 updated for the third destination, and both READMEs updated.
### Implemented

- Keys can now be stored in Obsidian's `SecretStorage` instead of being re-entered on every start.
  Settings hold only the secret **name**; the value never reaches `data.json`, and the bundle check now
  fails if a secret value can reach the saved settings. A session-only override remains available and
  takes precedence (ADR-013).
- `src/core/jev.ts` now supports the OpenRouter route as the default destination. The request pins
  `provider: {only:['typesafe'],allow_fallbacks:false,zdr:true,data_collection:'deny'}` so the prompt cannot
  fall back to a provider that does not return score probabilities. Validation requires the calibrated
  distribution, verifies the resolved model version (`typesafe/jev-1.13` with an optional `-YYYYMMDD`
  snapshot suffix), and reads the actual charged cost from `usage.cost` when the route reports it.
- `src/main.ts` gains the destination option, the OpenRouter third-party consent notice, per-destination
  session keys, and actual-cost display.
- Added `scripts/smoke-live.mjs` and `npm run test:live` for the AT-07 live smoke test. It requires
  `RUN_LIVE_TESTS=1` plus an environment API key, sends one synthetic request, and never writes or prints
  the key.
- Unit tests: 24 to 29, covering OpenRouter payload pinning, the resolved snapshot version, actual cost
  reporting, and rejection of a wrong model, provider warnings, and a missing distribution.

### Exclusion and oversized notes, measured in the real app

- AT-05 and AT-11 now pass, so 17 of the 20 acceptance tests are measured passes and 3 remain partial.
- **AT-05**: with `private/` and `private2/` excluded by folder and `private@@ by tag, a
  marker in those notes returns no hits at all, including a note tagged only by an inline `#private` in
  its body. A marker inside `.obsidian` also returns nothing, and Obsidian's vault API does not even
  expose that file. The control note is still found, and `allowed()` agrees on all six. The unit tests
  cover the case the app cannot be asked to change: with the config directory renamed to `Settings`,
  `Settings/a.md` is excluded and `Settings2/a.md` is not.
- **AT-11**: a 51MiB note (53,477,421 bytes) is refused on `stat.size` alone, never read, and counted as
  one oversized skip. 55 notes totalling 41MiB stay under the cap and all index, in 2,868ms with a 104MB
  heap. The oversized note is unfindable while the others return 50 results. Frame gaps were p95 44.6ms
  with one 207.8ms frame, during Obsidian's own startup.
- AT-07 and AT-13 need a live Jev key, and AT-14 needs a real tag and publish.

### Response validation and result navigation, measured

- AT-09 and AT-02 now pass, so 15 of the 20 acceptance tests are measured passes and 5 remain partial.
- **AT-09**: a score outside 0-2, a null score, probabilities that do not form a distribution, and a
  missing answer are each refused with "Local fallback: invalid-response", and the 23 local results are
  kept. A note carrying `<script>` and an `onerror` handler renders as text: no script runs,
  no `img` or `script` element appears in the result list.
- **AT-02**: clicking a result opens the note and moves the cursor to the **first line of the matching
  chunk**, which the test confirms at line 314 of a paragraph-separated note whose match is in the second
  half. The excerpt shown in the result list is the text at that line. The jump is chunk-level, not to the
  exact matching line, and that distinction is recorded rather than smoothed over.

### Remaining Jev-path acceptance tests, and a real IME defect

- AT-16 and AT-19 now pass, which leaves no acceptance test unrun: 13 measured passes and 7 partial.
- **AT-16**: with 25 candidates of about 1,200 characters each, the preview holds **6 documents, not 20**,
  and the request is 23,718 bytes against the 24,576 ceiling. The preview and the sent body match, and the
  status reports "Jev ranked · 6 chunks", so the documents left out are visible rather than silent. The
  implementation caps the request instead of splitting it into batches; the design's three-batch case is
  therefore handled by stopping, which is recorded rather than glossed over.
- **AT-19**: a composition now suppresses the search. This was a real defect: `input` fires while
  an IME is still converting, and the handler scheduled a search anyway, so results flickered against
  half-composed readings. The view tracks `composing` and waits for `compositionend`. Escape
  closes the preview without sending, and at 200% zoom the view still searches and renders.
- The harness also had to learn that Obsidian destroys and recreates the modal window: a cached CDP
  connection went stale after a few scenarios, which made later previews look like they never opened.
  It now reconnects and looks for the preview in either window.

### Re-measured on real Japanese text

- The synthetic corpus was written by the same author as the tokenizer, so it could not show whether the
  katakana word token helps on prose nobody tuned for. scripts/fetch-public-corpus.mjs now fetches real
  Japanese Wikipedia introductions, pinning each article's pageid and revid in a manifest so the corpus
  can be refetched at the same revisions. The text stays in .sandbox/ and is never committed.
- 806 articles (mean 234 characters) and two query constructions:
  - A sentence taken verbatim from the article is found almost always: Recall@50 100%, MRR 0.97 under
    both segmentations. That task cannot separate them, so it is not used to claim anything about quality.
  - A single katakana loanword as the query, with every document containing that word marked relevant.
    Here the change is one-directional: Recall@5 46.3% -> 61.0%, Recall@10 62.0% -> 75.3%,
    MRR 0.384 -> 0.459, median rank 6 -> 4, with **232 of 400 queries improved and none worsened**.
- The same corpus quantifies why: a median of 112 documents (p90 241, worst 356) share a bigram with the
  query word without containing it, so the bigram-only view fills the candidate list with プロ-style
  fragments from プロジェクト and プログラマー.
- The scope is recorded as narrowly as it was measured: this is a katakana-word query, on short
  documents, with corpus-derived labels rather than human judgements. Long documents, compounds, kanji
  and synonym queries are unmeasured, and the nDCG change after Jev still needs a key (AT-13).

### Release readiness

- Added `NOTICE` and `docs/privacy.md`. The privacy statement says what leaves the machine (only
  the top-20 candidate excerpts, and only after you approve the preview), what stays local, and what is
  not implemented (no telemetry). It states plainly that Obsidian's SecretStorage is profile-scoped
  rather than vault-scoped, and does not claim it is encrypted or that it never syncs.
- Added `scripts/verify-release.mjs` (AT-14): version agreement across manifest.json, package.json
  and versions.json, the licence files the manifest promises, and a scan of every tracked file for a
  key, an email address, a private key or a developer absolute path.
- That scan immediately found eight GUI scripts and four documents carrying this machine's home
  directory. The scripts now resolve Obsidian through `scripts/obsidian-exe.mjs` (honouring
  `OBSIDIAN_EXE`, otherwise the usual install locations), and the documents describe the location
  instead of naming it. Nothing personal is left in the tree.
- Added `.github/workflows/release.yml`: on a `v*` tag it rebuilds, checks the tag names the
  manifest version, packages the three files Obsidian loads, inspects the archive contents, and
  publishes. CI now also runs the release inspection on every push.
- Recorded Obsidian's own version as 1.13.4 and the real API contract as still unverified: a controlled
  transport proves the plugin's handling, not the live service.

### Jev integration verified without a key

- AT-03, AT-04, AT-06, AT-15 and AT-17 now pass. The built bundle calls
  `(0, import_node_https.request)(...)`, so replacing that property at runtime intercepts every
  send. `scripts/verify-at-mock.mjs` uses it to drive the plugin against a controlled response, which
  means response handling, the deadline, cancellation and approval invalidation can all be checked
  without a key and without sending anything. The real API contract stays a separate question,
  verified once by AT-07; a mock result is not evidence that the live API behaves this way.
- Results: the approved preview body and the sent body hash identically (8,656 bytes to
  https://openrouter.ai/api/alpha/decisions, with the Bearer header attached); a high score reorders
  and reports "Jev ranked"; every score below 1 keeps the local order; an invalid response falls back
  with "model-mismatch"; a response that lands after the query changed does not overwrite the view; a
  hanging response is cut off at 4,497ms; a short Retry-After retries once (2 requests) while a long
  one stops after 1; ten cancel presses still produce one physical request; deleting a candidate while
  the preview is open sends nothing.
- Eleven acceptance tests are now measured passes, eight partial and one unrun (AT-13).
- Corrects the recorded Obsidian version: the app reports 1.13.4, not 1.13.7.
- Note for reuse: Obsidian 1.13.4 opens modals in a separate window, so the consent dialog is driven
  through its own CDP target. `scripts/cdp-client.mjs` now accepts a target selector.

### Judgement cache and diagnostics

- Implements the designed core/cache. The key is a hash of the request body plus the route and a hash
  of the API key, so the body's own content addressing covers note edits, exclusion changes and
  candidate-set changes: any of them produces a different key and cannot return a stale judgement.
  The key material is hashed, so the API key never sits in the map. TTL is configurable (0-60
  minutes, default 30, 0 disables), the LRU holds at most 200 entries, and nothing is written to disk.
  Failures are never stored, because evaluate() throws rather than returning. The cache is emptied
  when a setting changes and when the plugin unloads, and a hit reports "cache hit · no new charge"
  instead of showing a cost that was not incurred.
- Adds the designed diagnostics export: version and counts only, never a path, note text, query or key.
- AT-18 now passes in a real Obsidian: a judgement round-trips through the live cache, setting the TTL
  to 0 empties it, unloading empties it, the diagnostics object leaks neither a path nor body text nor
  the query, and data.json stores the TTL but no judgement. Six acceptance tests are measured passes.
- Unit tests: 30 to 35.

### AT-20 measured

- An unknown or hostile settings schema does not crash the plugin and does not destroy the stored
  file. `scripts/verify-at20.mjs` loads a schema with a non-array `folders`, mixed-type
  `tags`, a string `enabled`, an array `endpoint`, secrets containing a path traversal,
  uppercase and a 200-character value, plus unknown keys. Every field falls back to a safe default,
  local search still works, the renderer reports no exception, and the stored file is byte-identical
  afterwards. Five acceptance tests are now measured passes.

### AT-12 measured, and a schedule-map leak fixed

- AT-12 now passes in a real Obsidian: 100 rapid creations, 50 edits, 25 deletions and 10 renames left
  the index at 95 notes, exactly matching the 95 on disk, with the deleted note unfindable, the edited
  note re-indexed and its old terms discarded. Five disable/enable cycles each rebuilt the same 95
  notes with no pending work, and no timers were left behind.
- **Fixed**: the per-path change counter could reuse a stamp after a delete and recreate, which would
  let a stale queued task overwrite newer state, and the map holding those stamps grew forever because
  renamed and deleted paths were never removed. Stamps now come from one global counter and dead paths
  are dropped; after 10 renames the map still held exactly 95 entries.
- Adds `scripts/verify-at12.mjs`.

### Large vault measured in the real app

- Indexing 10,000 notes in a real Obsidian took 52.1s and now takes 16.4s. The index yielded to the
  event loop after every note, and that timer cost more than the indexing it protected; it now yields
  on an 8ms budget. The UI never froze in either case — the p95 frame gap stayed near 60fps and only
  two frames exceeded 200ms across every run — but p95 did move from 17-18ms to 20-23ms, so the speed
  is a trade against smoothness, not a free win. Record:
  [docs/benchmark/result-load-10k.md](docs/benchmark/result-load-10k.md).
- **Bug found and fixed**: "Ready" was reported before the index was complete. `allowed()` requires a
  metadata cache entry, and notes whose entry had not resolved yet were skipped silently. One run
  reported ready with only 6,400 of 10,000 notes indexed. Faster indexing exposed this, because the
  old 52s build gave Obsidian's metadata scan time to finish. Skipped notes are now tracked and
  retried before the ready flag is set; every run since reports 10,000 notes at ready.
- Adds `scripts/load-test.mjs`, which drives a real Obsidian over CDP and samples long tasks, frame
  gaps and heap while the plugin indexes.
- Note for anyone reusing the harness: `app.plugins.enablePlugin()` does not load the plugin on a
  fresh profile. The plugin must be listed in `community-plugins.json` so Obsidian loads it at startup.

### Retrieval measured

- The local candidate stage was measured on a deterministic synthetic corpus, because Jev can only
  rerank what that stage surfaces. At 10,000 notes, Recall@50 was 68.8% overall, 91.7% when the query
  reused the note's wording and 45.8% when it did not. Raising the cut to 1,000 still left 18.7%
  unfound, so fetching more candidates is not a fix. The record is
  [docs/benchmark/result-synthetic-recall.md](docs/benchmark/result-synthetic-recall.md).
- Splitting the failures showed two different problems: 6 of 48 queries share no term with their
  target note at all, so no BM25 variant can find them, while 9 match but rank below the cut (median
  328th). The vocabulary wall does not move with vault size; the ranking loss does.
- **ADR-014**: `tokenize` now also emits each katakana run as one word. Bigram splitting turned
  `デプロイ` into `デプ / プロ / ロイ`, and `プロ` also occurs in `プロジェクト` and
  `プログラマー`, so the term lost its identity. The predicted failure was repaired at both
  scales (`デプロイはいつできる` went from 85th to 1st at 10,000 notes and 4th to 1st at 400) and literal
  MRR rose 0.889 to 0.931. The overall Recall@50 gain is 2.0 points, one query of 48, and zero at 400
  notes, so it is not treated as statistical evidence and no accuracy claim is made until the real
  corpus is measured.
- Unit tests: 29 to 30.

### Live API confirmed

- One synthetic request through OpenRouter from the real plugin returned
  `API OK (openrouter.ai): score 2 / 2 - $0.000016 (actual)`. This confirms that the route authenticates,
  that `confidence` and `probabilities` are present (strict validation passed), that `usage.cost` is
  reported so the actual charge can be shown, that the resolved `model` matches `typesafe/jev-1.13`, and
  that the response arrives inside the 4 second product deadline.
- Still unconfirmed: the full response shape, the exact resolved `model` string, whether `legend` is
  present, and the numeric latency. `npm run test:live` captures these.

## [0.1.0] - 2026-09-18

Initial development preview. This is not a stable release for general distribution, and the
verification status is recorded in [docs/implementation-preview.md](docs/implementation-preview.md).

### Added

- Local, offline Markdown search: NFKC normalization, Japanese code point bigrams, ASCII words,
  ATX heading chunking that ignores fenced code, and frontmatter exclusion.
- Fielded BM25 ranking over title, heading, and body with incremental index updates.
- Exclusion policy for folders, tags, hidden directories, and the vault configuration directory.
- Search view with a debounced query, invalidation on vault changes, and navigation to the source
  line of a hit.
- Consent-gated Jev reranking over at most 20 candidates and 24 KiB, with a full JSON preview
  before every transmission.
- Two fixed destinations only: Vercel AI Gateway (default) and the TypeSafe API directly.
- Runtime validation of Jev responses, including score range, probabilities, rounding tolerance,
  provider warnings, and model version checks, with local fallback on any failure.
- A single overall 4 second deadline, one retry for 429/529, and cancellation support.
- Session-only API keys, held per destination and never persisted to disk.
- Settings for enabling Jev, choosing the destination, excluded folders and tags, index rebuild,
  and a synthetic-data connection test.

### Security

- No API key is required for local search, and external transmission defaults to off.
- Every transmission is previewed in full and approved explicitly; there is no bulk session
  consent and no background sending.
- Keys, note bodies, and queries are never written to logs, settings files, or telemetry.
- The plugin never creates, edits, deletes, or moves notes.
- Response content is never treated as HTML or executable code.

### Known gaps

- Live Jev API transmission is unverified because no API key is available in the environment.
- Load testing at 10,000 notes, cross-batch rank merging, response caching, monthly budget
  persistence, and full Japanese/English string dictionaries are not implemented.
- The design describes a `core/{index,policy,pipeline,jev,cache}` layout with injectable
  transports; the current implementation is smaller and depends on `node:https` directly.

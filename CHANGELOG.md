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

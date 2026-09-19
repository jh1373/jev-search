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

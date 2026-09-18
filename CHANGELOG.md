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
- The plugin code has **not** been updated for OpenRouter yet; `src/core/jev.ts` still implements only the
  Gateway and direct routes.

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

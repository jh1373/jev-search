# Jev Search — Development plan and detailed design

Updated: 2026-09-18 / Design version: 0.2 / Status: design draft for starting implementation

## Current artifact

This repository is at the **development preview implementation stage**. It contains code and
build output for local search and consent-based Jev reranking. It is not a stable release for
general distribution. See the [development preview record](docs/implementation-preview.md) for
the current implementation scope, verification results, and gaps against the design.
No existing personal vault has been modified.

The product name "Jev Search" and the ID `jev-search` are provisional. Name collisions and
trademarks will be checked before release. This is not presented as an official TypeSafe or
Obsidian product.

## Reading order

1. [Product requirements and architecture](docs/design/01-architecture.md)
2. [Jev transport, runtime validation, and caching](docs/design/02-jev-client.md)
3. [Japanese search, indexing, and reranking](docs/design/03-search-rerank.md)
4. [UI, transmission consent, and secrets](docs/design/04-ui-privacy.md)
5. [Testing, release, and operations](docs/design/05-testing-release.md)
6. [Gates, decisions, and risks](docs/design/06-roadmap.md)
7. [Requirements to acceptance test mapping](docs/design/07-acceptance.md)
8. [Sources, confirmed facts, and open questions](docs/design/08-evidence.md)
9. [Japanese evaluation protocol](docs/benchmark/protocol.md)
10. [Review record and improvement backlog (2026-09-18)](docs/reviews/2026-09-18-product-tradeoffs.md)

The five review items are unverified. They are checked at the start and end of each
implementation gate, and measurements and decisions are appended.

## Key decisions

- An Obsidian-native UI. No CLI, Python, or separate server is required from the user.
- The first version targets desktop, with read-only Markdown search. Mobile support is not claimed.
- Local search works without an API key. Jev is enabled explicitly, and every transmission is
  previewed before it is sent.
- Jev reranks results. Semantic search, answer generation, and note editing are out of scope for
  the first version.
- Only two fixed destinations are possible: **via Vercel AI Gateway (default)** and the TypeSafe
  API directly. No arbitrary URL can be configured.
- Because the developer does not yet hold a direct TypeSafe key, development proceeds through the
  Gateway (ADR-011).
- Exclusion is applied twice: before indexing and immediately before transmission. Unevaluated
  candidates are not silently dropped.
- The first version never deletes candidates based on the Jev score. It only reorders them.
- Published prices, models, and SDK details are not guarantees. They are verified against the real
  API and inside Obsidian before release.

## Development environment check results

| Item | Finding |
|---|---|
| Working directory | `C:\Users\systemuser\Desktop\Jev×Obsidian` |
| Obsidian executable | Existence of `C:\Users\systemuser\AppData\Local\Programs\Obsidian\Obsidian.exe` confirmed |
| Node / npm / Git | 24.18.0 / 11.15.0 / 2.52.0.windows.1 |
| npm registry query | obsidian 1.13.1 / typescript 7.0.2 / esbuild 0.28.2 / vitest 5.0.1 |
| API key | No direct TypeSafe key yet (on the waiting list). Development is planned through a Vercel AI Gateway key |
| Existing vault | Only its location was read from Obsidian settings. It is not used for testing |

Querying the npm registry is not a compatibility verification. Dependencies are adopted and pinned
after a real build in G0. The OS Node and the Electron/Chromium inside Obsidian are different
environments.

## Next implementation gates

G0: connection spike using synthetic notes only -> G1: local search -> G2: consent-based Jev
integration -> G3: publishable Japanese evaluation -> G4: non-developer beta -> G5: public release.
See designs 06 and 07 for the completion criteria of each gate.

Do not paste secrets into chat, the README, or Git.
Live API tests run only through an explicit command, with dedicated synthetic data, within a
request limit.

## Tests

```
npm run check       # typecheck -> 24 unit tests -> build
npm run test:bundle # load the generated bundle and run local search
npm run test:gui    # real Obsidian GUI E2E (dedicated vault, launch to exit, evidence)
```

`test:gui` refuses to run outside its dedicated vault and terminates only the process it started.
Evidence (screenshots, report/summary) is written to `.sandbox/gui-e2e/evidence/`.
No personal vault and no live API are used. See the
[development preview record](docs/implementation-preview.md) for details and unverified areas.

## Design checks

`C:\Users\systemuser\Desktop\Jev×Obsidian\scripts\verify-design.ps1` mechanically checks
document existence, local links, requirement ID references, and mojibake.
It does not replace plugin behaviour, API, or security auditing.

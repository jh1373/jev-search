# Jev Search — Development plan and detailed design

Updated: 2026-09-19 / Design version: 0.2 / Plugin: 0.1.0 / Status: development preview (all 20 acceptance tests measured)

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

1. [Why Jev x Obsidian](docs/design/00-why-jev-obsidian.md) - start here
2. [Product requirements and architecture](docs/design/01-architecture.md)
3. [Jev transport, runtime validation, and caching](docs/design/02-jev-client.md)
4. [Japanese search, indexing, and reranking](docs/design/03-search-rerank.md)
5. [UI, transmission consent, and secrets](docs/design/04-ui-privacy.md)
6. [Testing, release, and operations](docs/design/05-testing-release.md)
7. [Gates, decisions, and risks](docs/design/06-roadmap.md)
8. [Requirements to acceptance test mapping](docs/design/07-acceptance.md)
9. [Sources, confirmed facts, and open questions](docs/design/08-evidence.md)
10. [Japanese evaluation protocol](docs/benchmark/protocol.md)
11. [Review record and improvement backlog (2026-09-18)](docs/reviews/2026-09-18-product-tradeoffs.md)
12. [Acceptance test status (what is measured and what is not)](docs/acceptance-status.md)
13. [Re-measurement on a public corpus (Japanese Wikipedia, real text)](docs/benchmark/result-public-corpus.md)
14. [nDCG after Jev reranking (public corpus, live API)](docs/benchmark/result-ndcg-live.md)
15. [10,000-note load test](docs/benchmark/result-load-10k.md)
16. [Privacy (what leaves the machine and what stays)](docs/privacy.md)

All twenty acceptance tests are measured. The one thing that could not be exercised is AT-07's direct
route, which is unreachable while TypeSafe's waiting list stands; the OpenRouter route passes.

| Measurement | Result |
|---|---|
| Sending with Jev off | 0, even with a key present |
| Indexing 10,000 notes | 52.1s -> **16.4s**, with no UI stall |
| A 51MiB note | Refused on `stat.size`, never read |
| Recall@5, katakana queries, 806 public articles | 46.3% -> **61.0%** |
| nDCG@10 after Jev, 120 queries | 0.5258 -> **0.8788** |

Read the interpretation, the limits, and what was not measured in the linked documents and in the
[acceptance test status](docs/acceptance-status.md). **Do not use this table alone as evidence of
accuracy.**

## Key decisions

- An Obsidian-native UI. No CLI, Python, or separate server is required from the user.
- The first version targets desktop, with read-only Markdown search. Mobile support is not claimed.
- Local search works without an API key. Jev is enabled explicitly, and every transmission is
  previewed before it is sent.
- Jev reranks results. Semantic search, answer generation, and note editing are out of scope for
  the first version.
- Destinations are fixed in code, and no arbitrary URL can be configured. **General users are
  offered two routes: OpenRouter and the TypeSafe API directly.** Development and verification use
  **OpenRouter (default)** as the first route, TypeSafe direct as the second, and Vercel AI Gateway as
  the third (ADR-012).
- The Gateway cannot verify the resolved model version, so it is not used as the primary route for
  quality verification.
- Keys resolve in the order "session override" then "Obsidian SecretStorage". Settings hold only the
  secret **name**; the value never reaches `data.json`, and it survives a restart (ADR-013). The storage
  backend and sync behaviour are unverified, so no encryption or non-sync claim is made.
- Exclusion is applied twice: before indexing and immediately before transmission. Unevaluated
  candidates are not silently dropped.
- The first version never deletes candidates based on the Jev score. It only reorders them.
- Published prices, models, and SDK details are not guarantees. They are verified against the real
  API and inside Obsidian before release.

## Development environment check results

| Item | Finding |
|---|---|
| Working directory | A locally cloned working tree (absolute paths are not recorded in the repository) |
| Obsidian executable | Detected from the usual install locations; override with `OBSIDIAN_EXE` |
| Node / npm / Git | 24.18.0 / 11.15.0 / 2.52.0.windows.1 |
| npm registry query | obsidian 1.13.1 / typescript 7.0.2 / esbuild 0.28.2 / vitest 5.0.1 |
| API key | No direct TypeSafe key yet (on the waiting list). An **OpenRouter key has been issued**. Development proceeds through OpenRouter (ADR-012) |
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
npm run check              # typecheck -> unit tests -> build
npm run test:bundle        # load the generated bundle and run local search
npm run test:release       # version agreement, LICENSE/NOTICE, no secrets or personal paths
npm run test:release:zip   # package and inspect the archive without publishing it
npm run test:gui           # real Obsidian GUI E2E (dedicated vault, launch to exit, evidence)
npm run test:mock          # Jev response handling without a live key (controlled transport)
npm run test:load          # load test with 10,000 synthetic notes
npm run test:at11-large    # one 51MiB note and 41MiB in total
npm run test:ndcg          # nDCG after Jev reranking (needs `OPENROUTER_API_KEY`)
```

`test:gui` refuses to run outside its dedicated vault and terminates only the process it started.
Evidence (screenshots, report/summary) is written to `.sandbox/gui-e2e/evidence/`.
No personal vault and no live API are used. See the
[development preview record](docs/implementation-preview.md) for details and unverified areas.

## Design checks

`scripts/verify-design.ps1` mechanically checks
document existence, local links, requirement ID references, and mojibake.
It does not replace plugin behaviour, API, or security auditing.

# Dependencies: what is pinned, what is accepted, and why

`pnpm audit` runs in CI and fails the build on **high** or worse. This file records every workspace override and any advisory intentionally ignored by the audit gate; `scripts/dependency-audit.test.ts` checks that list against the package configuration.

## Current audit

On 2026-11-02, the locked dependency tree reported 9 advisories: 8 moderate and 1 low, with no high or critical findings. An in-range workspace update, followed by current patched releases of Vitest and `@vitest/coverage-v8`, removed the prior Next.js, Tinypool, shell-quote, undici, multer, and other high or critical findings. The updated `decode-uri-component` override clears its high finding.

The Zod constrained-collection memory exhaustion advisory was reached only through `apps/mobile -> expo -> @expo/cli -> zod`. Expo SDK 57 pins Zod 3.x, while the patched range starts at Zod 4.6.6. A scoped `@expo/cli>zod` override moves only the CLI tool to Zod 4.6.7; Expo CLI `config --type public` succeeds with it. The application dependencies remain on their existing Zod catalog version.

## Overrides

`pnpm.overrides` in `package.json`:

| Package                | Forced to | Reason                                                                                                                                                                         |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `multer`               | `^2.3.0`  | `@nestjs/platform-express` pins a vulnerable 2.x release; the patched release stays in the same major and protects the KYC upload path.                                        |
| `postcss`              | `^8.5.26` | The Next.js tree previously pinned an older release affected by high advisories; the override keeps all workspace copies on the patched 8.x line.                              |
| `deepmerge-ts`         | `^8.0.0`  | Prisma config pins an older major. The merge handles repository-owned configuration only; the upgrade is explicit and covered by the workspace checks.                         |
| `decode-uri-component` | `^0.5.1`  | Expo Router's `query-string` dependency pins 0.2.x, which has a high denial-of-service advisory; 0.5.1 supplies the patched implementation with the same exported decoder API. |
| `@expo/cli>zod`        | `^4.6.7`  | Expo SDK 57 pins Zod 3.25.76 in its CLI. Zod 4.6.7 is scoped to the CLI only; `expo config --type public` passes with the override.                                            |

Overrides affect all packages in the workspace, so each has a recorded reason and is included in the package audit test.

## Ignored advisories

`pnpm.auditConfig.ignoreGhsas` in `package.json`, accepted by the repository owner on 2026-11-18 as temporary:

| Advisory              | Package     | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GHSA-fc5q-39xc-vjpf` | `picomatch` | Rated high on 2026-11-17 (CVE-2026-112366: ReDoS from a crafted extglob such as `+(*)`). Every release up to 4.0.7, the latest, is affected and no patched version exists, so neither an update nor an override can clear it. Both copies are developer tooling: `typescript-eslint -> @typescript-eslint/typescript-estree -> tinyglobby -> picomatch` (lint) and `apps/mobile -> expo -> @expo/cli -> @expo/metro-file-map -> jest-worker -> jest-util -> picomatch` (the Expo CLI). Each matches globs written in this repository, never a pattern from a request, and neither is in the API, worker or web runtime. **Remove this entry once a patched picomatch is published and the tree resolves to it.** |

## Remaining advisories

No other high or critical advisories remain. The ten moderate and one low findings are below the CI threshold and remain visible in `pnpm audit`. Review them during normal dependency updates.

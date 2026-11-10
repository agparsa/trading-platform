# Dependencies: what is pinned, what is accepted, and why

`pnpm audit` runs in CI and fails the build on **high** or worse. This file records every workspace override and any advisory intentionally ignored by the audit gate; `scripts/dependency-audit.test.ts` checks that list against the package configuration.

## Current audit

On 2026-11-04, the locked dependency tree reports 1 low advisory and no moderate, high, or critical findings. The security updates pin Next.js 15.5.28, Nodemailer 10.1.4, Vitest and `@vitest/coverage-v8` 4.1.12, and the patched transitive releases listed below. Vite is pinned to 7.3.7 to match Vitest's peer range and avoid an unsupported major-version jump.

The Zod constrained-collection memory exhaustion advisory was reached only through `apps/mobile -> expo -> @expo/cli -> zod`. Expo SDK 57 pins Zod 3.x, while the patched range starts at Zod 4.6.6. A scoped `@expo/cli>zod` override moves only the CLI tool to Zod 4.6.7; Expo CLI `config --type public` succeeds with it. The application dependencies remain on their existing Zod catalog version.

## Overrides

`pnpm.overrides` in `package.json`:

| Package                | Forced to | Reason                                                                                                                                                                         |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `multer`               | `^2.5.0`  | `@nestjs/platform-express` pins a vulnerable 2.x release; the patched release stays in the same major and protects the KYC upload path.                                        |
| `postcss`              | `^8.5.26` | The Next.js tree previously pinned an older release affected by high advisories; the override keeps all workspace copies on the patched 8.x line.                              |
| `deepmerge-ts`         | `^8.0.0`  | Prisma config pins an older major. The merge handles repository-owned configuration only; the upgrade is explicit and covered by the workspace checks.                         |
| `decode-uri-component` | `^0.5.1`  | Expo Router's `query-string` dependency pins 0.2.x, which has a high denial-of-service advisory; 0.5.1 supplies the patched implementation with the same exported decoder API. |
| `@expo/cli>zod`        | `^4.6.7`  | Expo SDK 57 pins Zod 3.25.76 in its CLI. Zod 4.6.7 is scoped to the CLI only; `expo config --type public` passes with the override.                                            |
| `body-parser`          | `^2.4.0`  | Keeps Express's parser on the patched 2.x release.                                                                                                                             |
| `vite`                 | `7.3.7`   | Pins the patched Vite 7 release required by Vitest 4.1.12; avoids resolving Vite 8 through a broad lower-bound override.                                                       |

The advisory-specific overrides use these exact range keys in `package.json`: `vitest@>=2.1.0 <4.1.11`, `@vitest/mocker@>=2.1.0 <4.1.11`, `js-yaml@>=5.0.0 <=5.4.0`, `source-map-js@>=1.0.0 <1.2.2`, `tinypool@<=2.1.0`, `tinypool@<2.1.2`, `sharp@<0.35.5`, `shell-quote@>=1.8.4 <1.11.0`, `next@>=15.0.0 <15.5.27`, `@vitest/mocker@>=2.1.0-beta.7 <4.1.12`, `next@>=10.0.0 <=15.5.27`, `next@>=13.0.0 <=15.5.27`, `multer@>=2.0.0 <2.5.0`, `nodemailer@>=3.0.0 <10.1.4`, `nodemailer@>=3.0.0 <=10.0.12`, `qs@>=6.7.0 <=6.16.0`, `minimatch@<11.0.1`, `glob@>=9.0.0 <=14.0.1`, and `node-forge@<=1.4.0`. These range-scoped pins keep affected transitive dependencies on the minimum patched releases while the direct catalog entries are upgraded where needed.

Overrides affect all packages in the workspace, so each has a recorded reason and is included in the package audit test.

## Remaining advisories

The remaining low `deepmerge` advisory has no patched version in the registry advisory. It remains visible in `pnpm audit`; no advisory is silenced with `auditConfig` ignores.

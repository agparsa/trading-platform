# Dependencies: what is pinned, what is accepted, and why

`pnpm audit` runs in CI and fails the build on **high** or worse. This file is
the other half of that gate: every deviation from "just take the fix" is written
down here with a reason, and `scripts/dependency-audit.test.ts` checks this file
against `package.json` in both directions — an override or an ignored advisory
with no entry fails, and an entry for something no longer pinned or ignored
fails too, so the file cannot rot into folklore.

## How this came to be written

`docs/penetration-checklist.md` listed dependency vulnerabilities under what the
penetration suite deliberately does _not_ cover, with the reason that
"`pnpm audit` belongs in CI, not in a script that boots the API". That reasoning
is right. CI did not run it, and nothing else did either.

The first run found **22 advisories: 2 critical, 11 high, 8 moderate, 1 low**.
Two criticals in `next`; `multer` high, reached through
`@nestjs/platform-express`, which is the path identity documents are uploaded
on; `qs` under `express`, which parses every query string the API receives.
Most were stale lockfile resolutions inside ranges the workspace already
allowed — nobody had run the update because nothing asked.

An in-range `pnpm update -r` cleared both criticals and five of the highs. The
overrides below cleared the rest.

## Overrides

`pnpm.overrides` in `package.json`. Each of these is pinned **exactly** by its
parent, so there is no range for an update to find; an override is the only
route short of waiting for upstream.

| Package        | Forced to | Parent pins                                    | Why it is worth overriding                                                                                                                                                                                                                                                            |
| -------------- | --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `multer`       | `^2.3.0`  | `@nestjs/platform-express@11.2.5` pins `2.2.0` | GHSA-qvfw-j98x-7q72: a file-size limit bypassed by a race in an async `fileFilter`. This platform accepts identity documents on that path, so a bypassed size limit is storage abuse against a store holding KYC material. Same major, API-compatible.                                |
| `postcss`      | `^8.5.26` | `next@15.5.25` pins `8.4.31`                   | Two high advisories. Build-time only, and the workspace root already resolved `8.5.26`, so both versions were installed side by side before this.                                                                                                                                     |
| `deepmerge-ts` | `^8.0.0`  | `@prisma/config@6.19.3` pins `7.1.5`           | A major bump, taken rather than reasoned around: the merge it performs is over `prisma.config.ts`, a file this repository owns, so the advisory is not reachable from untrusted input — but "not reachable today" is an argument that expires, and the build gate proves the upgrade. |

An override changes a dependency for every package in the workspace, including
ones that asked for something else. That is why each needs a row here: a silent
override is a dependency decision nobody reviewed.

## Accepted for now

Nothing is in `pnpm.auditConfig`. These four are below the gate's threshold and
are recorded so that "moderate" does not quietly become "ignored".

| Advisory                                                          | Where                | Why it is not fixed yet                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest`, `@vitest/mocker` — path traversal via a redirected mock | the test runner      | Patched in **4.1.11**; this workspace is on 3.x. A major upgrade of the runner across 226 test files is its own change with its own risk, not a line in a security commit. The advisory is reachable only by a test that mocks a redirect, which is test code this repository writes. |
| `uuid` under `@expo/config-plugins`                               | the mobile toolchain | Expo pins it; build-time only, and it never ships in the app.                                                                                                                                                                                                                         |
| `decode-uri-component` under `expo-router`                        | the mobile app       | Expo's own dependency. Worth revisiting at the next Expo bump.                                                                                                                                                                                                                        |

Each of these is a reason to look again, not a reason to stop looking. The gate
is set at high because that is the line this repository can hold today; lowering
the threshold is a decision to be taken along with the work it creates.

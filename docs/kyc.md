# Identity verification

Who a person is, proved once, so that money can be paid out to them.

## Kept apart from trading

A withdrawal may require this to be `VERIFIED`. Opening a position never asks.
The specification says so, and the code enforces it structurally: `KycModule`
imports nothing from trading, nothing in trading imports it, and the only thing
another module may ask is `KycService.isVerified(userId)`. There is no column on
`users`, so no trading query carries a verification status it has no business
reading.

## The gap, stated rather than filled

**The only verification path in this repository is manual review by an operator
holding `kyc.review`.** There is no Sumsub, Onfido or Veriff adapter.

The same reasoning as payments: choosing a provider is a commercial decision —
price per check, which countries, which document types, data residency, who
signs the processing agreement — and an adapter written against public
documentation for a contract nobody has signed would be an integration that has
never verified anybody, sitting here looking finished.

What exists is real. A person submits documents; somebody with the capability
looks at them; the decision is recorded with a name against it and the person is
told. That is how a firm's first verifications are done and how many firms do
all of them. `KycProvider` in `@tp/kyc-core` is the port an automated provider
implements when one is chosen, and its "could not decide" outcome lands in the
same operator queue as everything else. The concrete adapter is **pending
provider selection**.

## States

```
NOT_STARTED ──→ PENDING ──┬──→ UNDER_REVIEW ──┬──→ VERIFIED ──┬──→ EXPIRED ──→ PENDING
                  ▲       │        │          │       │       └──→ NOT_STARTED (revoked)
                  │       │        └── back ──┘       │
                  │       └──→ VERIFIED / REJECTED    │
                  └──────────── REJECTED ─────────────┘  (submit again)
```

Two transitions are deliberately absent, and the state machine's tests assert
their absence. `VERIFIED → REJECTED` does not exist: a verification found to be
wrong is **revoked**, which goes to `NOT_STARTED` with a reason and is its own
audited act — a review decision rewritten after the fact would be a trail that
shows a rejection with no review behind it. And nothing leads into `EXPIRED` but
`VERIFIED`, because only something that was valid can run out.

## Documents

### Encrypted at rest, bound to their row

Every document is AES-256-GCM under the platform's sealing key, with its own
row id as additional authenticated data. `SecretBox.sealBytes` is a binary
framing added for this — the string form base64-encodes and joins with dots,
which is right for a TOTP secret and wrong for a ten-megabyte scan.

The binding matters at least as much here as for a TOTP secret. A document
copied from one person's row into another's would open under the key — the
encryption did its job — and a reviewer would be shown the wrong person's
passport as if it were theirs. With the binding, the copied bytes fail to open
in their new row, and `kyc.test.ts` does exactly that copy and asserts the
refusal.

`sealed_with_key_id` is copied out of the frame so a rotation job can find rows
to rewrite without opening each one.

### What the bytes are, not what the client said

The declared content type routes the body to the raw parser and nothing else.
`sniffContentType` reads the first bytes — JPEG, PNG, WebP, PDF — and what it
finds is what the row records. A file it cannot identify is refused, whatever
it was labelled: an HTML page sent as `image/png` is a 400. SVG is refused on
purpose; it can carry a script.

### Access audited

`kyc.documents.read` is a capability of its own, separate from `kyc.read_any`.
Knowing that a person is verified is what a support agent needs to answer "why
can't I withdraw"; seeing their passport is not, and a capability that meant
both would put every identity document on the platform one support ticket away.

Every opening writes `kyc.document.viewed` to the audit log with the reviewer's
id **before** a byte is returned, inside a transaction, so a failed audit write
means no document. That row — who saw whose identity, when — is the first thing
a data-protection inquiry asks for.

The review screen shows a document; it does not download one. The bytes live in
an object URL for as long as the viewer is open and are revoked when it closes,
and the response carries `Cache-Control: no-store`.

### Never in a log

`KycService` and `AdminKycService` log record ids and document kinds. Never a
name, a number, a filename or a byte. An engineer reading logs to find out why
an upload failed learns that a PASSPORT for record `…` was refused for its size,
and nothing about whose passport.

### Retention, stated

`KYC_DOCUMENT_RETENTION_DAYS` (default 1826, five years — the common regulatory
floor for identity records) after a record reaches a terminal state, the
maintenance sweep clears the bytes. The row stays: kind, hash, size, upload time
and `purged_at`. That a document of this kind was seen on this date is a fact
the record may need to stand on for years; the bytes are not.

Only documents from the decided attempt go. One uploaded after the last
decision belongs to a new submission and stays. A record still waiting for a
reviewer keeps its documents however old it is — purging them would make the
review impossible, and the delay is the platform's, not the person's.

A database trigger holds this in place: a document's identity (kind, hash,
size, upload time) cannot be edited after upload, bytes can be cleared once and
never replaced, and rows are never deleted. `resetDatabase` in the test harness
truncates the table, which the row triggers do not see; nothing in the
application does.

## Validity

`KYC_VALID_FOR_DAYS`, unset by default, makes a verification lapse. The gate
honours it to the minute: `isCurrentlyVerified` judges from `verified_at` and
the policy, not from the column, because the sweep that writes `EXPIRED` runs on
a schedule and a gate that trusted the column between two runs would pass a
verification the policy says is over. The sweep exists so the _person_ sees
"expired" on their screen rather than "verified" beside a withdrawal that
refuses.

## Capabilities

| Capability           | Means                                                   |
| -------------------- | ------------------------------------------------------- |
| `kyc.read`           | see your own status and what it still needs             |
| `kyc.submit`         | upload documents and submit them                        |
| `kyc.read_any`       | see anyone's status and the queue — never the documents |
| `kyc.documents.read` | open the documents themselves; every use audited        |
| `kyc.review`         | claim, decide, revoke                                   |

`SUPPORT` and `OPERATOR` hold `kyc.read_any` only. `RISK_MANAGER` and `ADMIN`
hold all three operator capabilities.

`kyc.review` and `kyc.submit` are an **incompatible pair**: verifying your own
identity is confirming your own deposit one step removed, because a
verification is what a withdrawal gate asks for.

## Two reviewers at once

`decide` is version-guarded. Two reviewers deciding the same record at the same
moment produce one decision and one refusal, not a status that depends on who
committed last. The test for this forces the interleaving — another writer's
version bump between the service's read and its write — because a
`Promise.allSettled` race passed for the wrong reason: the second call read the
record after the first had committed, the state check refused it, and deleting
the version guard did not fail the test.

## The upload

`PUT /kyc/documents/:kind`, bytes as the body, content type in the header,
filename in `X-Filename`. No multipart. A raw-body parser is registered on that
route alone with the document ceiling as its limit, so an oversized body is a
413 before a byte reaches the service, and the JSON parser everywhere else keeps
its default hundred kilobytes.

Nginx's `client_max_body_size` is raised for `/api/v1/kyc/documents` only; the
2 MB that stands everywhere else is right for every other route on the API.

## Mobile

The profile screen shows the verification status and, when something is
missing, says to add it on the web. It does not take documents: photographing
a passport needs the camera and file-picker modules, which this build does not
carry, and a button that opened nothing would be worse than the sentence. When
they are added, the endpoint is the same one.

## Configuration

| Variable                      | Default   | What it does                                           |
| ----------------------------- | --------- | ------------------------------------------------------ |
| `KYC_VALID_FOR_DAYS`          | _(unset)_ | how long a verification stays good; unset never lapses |
| `KYC_DOCUMENT_RETENTION_DAYS` | `1826`    | how long bytes are kept after a decision               |

The retention value is declared in both the API and the worker. The API states
the policy; the worker applies it.

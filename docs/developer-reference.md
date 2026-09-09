# The developer reference

`/developer` in the web app: every route the API serves, how to authenticate,
how to make a mutation idempotent, and how to verify a webhook.

## Fetched, not typed

Everything on the page comes from the running platform:

- **The route list** is the OpenAPI document the API builds at boot,
  served by `GET /developer/openapi.json`.
- **The conventions** — which header carries a webhook signature, which
  capabilities an API key or a service token may hold, which prefix each
  credential kind is minted with — come from `GET /developer/conventions`,
  which reads them from the constants the code enforces them with.

Nothing is written into the page by hand, so the page cannot describe a version
of the platform other than the one answering. A reference that drifts is worse
than none: it is read instead of the truth.

## Who may read it

Both routes are `@SelfService()`: any signed-in person, never a key or a token.
A script does not read documentation; its author does, in a browser. Keeping
the document behind a session also means the full route surface — every
administrative path included — is not enumerable by anybody who can reach the
host.

## Swagger's UI stays out of production

`SwaggerModule.setup` mounts on Express, outside Nest's guards, and is therefore
reachable without a token. It is mounted only when `NODE_ENV` is not
`production`; `scripts/deployment.test.ts` pins the `if` that keeps it so. The
document itself is available everywhere, through the guarded route above.

## Not here

- **Per-route permissions.** The OpenAPI document does not carry them, and the
  page does not guess: "which of these your credential may call is decided by
  the server on every request." `docs/API_INVENTORY.md`, generated from the
  controllers' decorators, is the reference for that, and is for operators.
- **Try-it-out.** A page that fires real requests at the platform from a
  documentation screen is a page that places a real order from a documentation
  screen. The terminal is for that.

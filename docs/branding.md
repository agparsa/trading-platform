# Branding

What a firm's visitors see it called and coloured, before and after signing in.

## What can be set

At `/admin/branding`, with `tenant.settings.manage` (the firm's owner):

| Field         | Shown                                                                                 | Empty means        |
| ------------- | ------------------------------------------------------------------------------------- | ------------------ |
| Platform name | sign-in page, the menu, the terminal header, the pages an emailed link opens, the tab | “Trading Platform” |
| Accent, dark  | links, the selected tab, the main button — on the dark theme                          | `#5b9cff`          |
| Accent, light | the same, on the light theme                                                          | `#1c5bc8`          |
| Support email | “Need help?” under the sign-in form and on the email-link pages                       | no line            |
| Website       | beside it                                                                             | no line            |

Each field is optional and independent. `null` returns it to the platform's own.

## The one rule: the accent stays readable

The accent is text (a link) and the face of the main button, whose label is
the page's own background colour. Contrast is symmetric, so one check covers
both: the accent against the background it is drawn on must reach **4.5:1**,
WCAG's figure for text. One per theme, because a colour that reads on dark
rarely reads on light. A colour that fails is refused — by the form as it is
typed, with its ratio, and by the server whatever sent it
(`accentProblem` in `@tp/shared-types`, used by both). The backgrounds are
`BRAND_BACKGROUND`; `branding.test.ts` checks them against `globals.css`.

## How it reaches the page

- `GET /branding` is public — the sign-in page wears it — and holds nothing a
  visitor would not see on the page. The firm is the one the request's host
  resolves to, as for sign-in.
- The API caches it per firm for a minute and drops the entry on the write
  that changes it; another API process may serve the old one for up to that
  minute.
- `BrandingSync` (web) writes the accents as CSS variables scoped to their own
  theme and sets the tab title; `useBrandName` is where every “Trading
  Platform” on screen now comes from.
- Every change is audited (`BRANDING_UPDATED`, before and after).

## Not covered

No logo upload (the mark is the platform's). The mobile app keeps the
platform's look. A firm's own domain is its `primaryHost`, set by the platform
when the broker is created.

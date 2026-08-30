# Deploying behind cPanel

For the case this repository actually met: a Hostinger VPS running CloudLinux
and cPanel/WHM, with a CDN in front of the hostname.

**This is the right shape for a test deployment and the wrong one for
production.** cPanel and CloudLinux exist to run many small PHP sites safely on
one box: LVE caps per-user CPU and memory, CageFS hides the filesystem, and the
panel rewrites service configuration and restarts daemons whenever it updates
itself. A long-lived Docker stack that holds WebSocket connections and expects
its own network and its own ports is not what any of that was built for. Put the
real thing on a plain VPS with nothing else on it.

What follows makes the test deployment work without taking the rest of the
server down.

## The problem in one line

Apache — and cPanel's own Nginx in front of it — serve every site and every
webmail on the machine from ports 80 and 443. This stack's edge wants the same
two ports.

## The arrangement

```
client → CDN → cPanel nginx :443 → Apache → 127.0.0.1:8443 → this stack's nginx → api / web
```

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.cpanel.yml \
  --env-file .env.production up -d
```

The override publishes the edge on loopback only, so nothing outside the machine
can reach it, and disables `certbot` — the public certificate belongs to cPanel,
which has AutoSSL and its own renewal. Two things renewing one hostname is one
more than can succeed.

Inside `.env.production`:

```
TRUSTED_PROXIES_FILE=./docker/nginx/trusted-proxies.local.conf
```

The stack still terminates TLS internally on a self-signed certificate. That hop
never leaves the host, and keeping it means this is the same deployment that runs
standalone rather than a second configuration that only exists here — and a
second configuration is a second thing to keep correct, of which the one that
gets tested is never the one in production.

## The Apache virtual host

cPanel regenerates virtual hosts on its own schedule and will discard anything
written directly into `httpd.conf`. Include files under `userdata` survive:

```
/etc/apache2/conf.d/userdata/ssl/2_4/<cpanel-user>/<domain>/trading.conf
```

```apache
SSLProxyEngine On
# The internal certificate is self-signed by design — this connection is to
# 127.0.0.1 and cannot be intercepted without already being on the host.
SSLProxyVerify none
SSLProxyCheckPeerName off
SSLProxyCheckPeerCN off

# The realtime path first: it must not fall through to the general rule, which
# would strip the upgrade and leave a terminal whose prices never move.
RewriteEngine On
RewriteCond %{HTTP:Upgrade} =websocket [NC]
RewriteRule /(.*) wss://127.0.0.1:8443/$1 [P,L]

ProxyPreserveHost On
ProxyPass        / https://127.0.0.1:8443/
ProxyPassReverse / https://127.0.0.1:8443/

# A trading terminal holds one connection open for as long as the trader is at
# their desk. The default timeout closes it every few minutes.
ProxyTimeout 3600
```

Then:

```bash
/scripts/ensure_vhost_includes --user=<cpanel-user>
/scripts/restartsrv_httpd
```

## The client address, all the way through

Every per-IP rate limit — this stack's and cPanel's — is only as meaningful as
the address behind it. There are three hops here and each one must pass the
client's address along, or what gets counted is the previous hop.

1. **The CDN** sends `X-Forwarded-For`.
2. **cPanel's Nginx and Apache** must trust the CDN's ranges and preserve that
   header, rather than replacing it with the CDN's own address. On Apache this
   is `mod_remoteip` with `RemoteIPHeader X-Forwarded-For` and a
   `RemoteIPTrustedProxy` line per CDN range.
3. **This stack** trusts loopback, via `trusted-proxies.local.conf`.

Get any of them wrong and the platform shares one rate-limit bucket across every
user, which is not a weaker limit but a different one, applied to the wrong
subject.

## What the CDN has to be told

- **Do not cache `/api/` or `/ws`.** A cached balance is a wrong balance.
- **Allow WebSocket.** The whole realtime path is one connection to `/ws`; a CDN
  that silently downgrades the upgrade produces a terminal that looks alive and
  never moves.
- **Do not cache `/.well-known/acme-challenge/`** if cPanel's AutoSSL is issuing
  the certificate.

## Before anyone signs in

```bash
pnpm smoke        # the API answers and refuses what it should
pnpm smoke:ws     # the realtime path survived all three hops
pnpm pentest      # 25 attacks, all expected to fail
```

`pnpm smoke:ws` against the public hostname is the one that matters here. It is
the only check that exercises the whole chain, and the WebSocket is the part of
this arrangement most likely to be quietly broken.

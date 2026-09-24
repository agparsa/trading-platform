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

## The cache, which served one user another user's account

The panel's `location /` caches proxied 200s for sixty minutes on a key of
scheme, host and URI — with no account of who asked. A freshly registered user
calling `/api/v1/accounts` was handed another user's account and balance,
because that user had asked first. That is not a hypothetical: a brand new
account came back as `TP-100001`, and two fresh users saw the same one.

Nothing under `/api/` may be cached, ever. The include below also takes the API
past Apache, which is where the WebSocket dies anyway:

```
/etc/nginx/conf.d/users/<user>/<domain>/trading-platform.conf
```

```nginx
location /api/ {
    proxy_pass https://127.0.0.1:8443;
    proxy_ssl_verify off;
    proxy_ssl_server_name on;
    proxy_cache off;
    proxy_buffering off;
    proxy_no_cache 1;
    proxy_cache_bypass 1;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location /ws {
    proxy_pass https://127.0.0.1:8443;
    proxy_ssl_verify off;
    proxy_ssl_server_name on;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
    proxy_buffering off;
    proxy_cache off;
}
```

`$connection_upgrade` has to exist. cPanel's nginx does not define it; add the
usual map in a file under `/etc/nginx/conf.d/`.

Then clear what is already cached — the poisoned entries outlive the fix by an
hour otherwise:

```bash
/scripts/ea-nginx clear_cache <user>
```

**Verify it, rather than assuming.** Register two users and check they see
different accounts. One command's worth of proof against a bug that hands one
trader another's balance.

## The WebSocket, which Apache would not carry

`mod_proxy_wstunnel` is installed but not enough: with `ProxyPass /ws
wss://127.0.0.1:8443/ws`, and with a `RewriteRule [P]`, Apache answered the
upgrade with 404 or hung. The platform's own edge answers the identical request
with `101 Switching Protocols`. The `location /ws` above skips Apache for that
path alone; everything else still travels the panel's normal route.

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

## The firewall, which removes Docker's rules when it restarts

A cPanel host runs CSF, and CSF owns iptables. When CSF restarts it writes its
own rules and removes Docker's — the NAT that lets a container reach anything
outside the host. Inbound traffic still works (it reaches the containers
through the host's proxy), so the site keeps serving and nothing looks wrong.
What breaks is everything that leaves: builds, webhooks, push, mail.

On 24 September 2026 at 02:40 an **automatic** CSF upgrade (v16.31 → v16.32)
did exactly this. Every upgrade after it stopped at step 5, reporting
`apk … DNS: transient error` and "no such package". `upgrade-server.sh` now
asks first, from inside the running API container, and stops before changing
anything with the cause and the check:

```
iptables -t nat -S POSTROUTING | grep MASQUERADE   # nothing printed: Docker's rules are gone
systemctl restart docker                           # puts them back; every container restarts
```

A Docker restart is the immediate fix, not the lasting one: the next CSF
restart or upgrade removes them again. The lasting one is CSF's own Docker
support — `DOCKER = "1"` in `/etc/csf/csf.conf`, with `DOCKER_NETWORK4`
covering the address pools in `/etc/docker/daemon.json` (on this host
`172.17.0.0/12` and `192.168.0.0/16`; CSF's default is `172.17.0.0/16`, which
misses the compose networks) — then `csf -r` and a Docker restart. Both are
changes to the host's firewall and belong to whoever administers it.

## Before anyone signs in

```bash
pnpm smoke        # the API answers and refuses what it should
pnpm smoke:ws     # the realtime path survived all three hops
pnpm pentest      # 25 attacks, all expected to fail
```

`pnpm smoke:ws` against the public hostname is the one that matters here. It is
the only check that exercises the whole chain, and the WebSocket is the part of
this arrangement most likely to be quietly broken.

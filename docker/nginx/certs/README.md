# TLS certificates

Put `fullchain.pem` and `privkey.pem` here, or point `TLS_CERT_DIR` at wherever
your issuer writes them.

Nothing in this directory is committed. If it is empty when the stack starts,
Nginx serves a self-signed certificate it generates itself and prints a warning
on every boot — the deployment is reachable, and unmistakably provisional.
Replace it before anyone signs in: HSTS is sent from the first response, and a
browser that has accepted this host once will not speak plain HTTP to it again.

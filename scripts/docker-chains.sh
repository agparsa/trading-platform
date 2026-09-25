#!/bin/sh
# Are Docker's own iptables chains still there?
#
#   docker-chains.sh
#
# Exit 0: yes. Exit 3: no — the `nat` table has no DOCKER chain. Any other
# status: this could not be asked (no iptables, not root), which is not an
# answer and must not be read as one.
#
# Why this exists. On 25 September a CSF reload removed Docker's rules, as
# it does every night. Container egress was put back by /etc/csf/csfpost.sh,
# and the upgrade's egress check passed — but CSF had also removed the DOCKER
# chain that Docker adds a DNAT rule to whenever it starts a container with a
# published port. Step 8 recreated nginx, Docker could not program its port
# ("iptables: No chain/target/match by that name"), and the site answered 503
# until Docker was restarted. Egress and Docker's chains are different
# questions; this asks the second one before anything is changed.
set -u

command -v iptables >/dev/null 2>&1 || exit 2
# Can the table be read at all? Without root it cannot, and that is not a no.
iptables -t nat -S >/dev/null 2>&1 || exit 2
iptables -t nat -S DOCKER >/dev/null 2>&1 && exit 0
exit 3

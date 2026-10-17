#!/usr/bin/env bash
# One-time setup, run as root on the Debian box by `deploy-agent.ps1 -Setup` (or
# `deploy-agent.sh --setup`), so later agent deploys need no password and no root
# access beyond the fixed activate helper.
#   setup-agent-deploy.sh HELPER USER
# HELPER is scripts/tomify-agent-activate.sh; USER is the account that deploys
# and runs the agent (tom).
set -euo pipefail

fail() {
  echo "setup-agent-deploy: $*" >&2
  exit 1
}

[[ $EUID -eq 0 ]] || fail 'run this with sudo'
helper=${1:-}
user=${2:-}
[[ -f $helper ]] || fail 'usage: setup-agent-deploy.sh HELPER USER'
[[ $user =~ ^[a-z_][a-z0-9_-]*$ ]] && id -u "$user" >/dev/null 2>&1 || fail "unknown user: $user"
bash -n "$helper" || fail "$helper is not a valid shell script"

# 1. The root helper, at a fixed root-owned path that only root can change.
install -o root -g root -m 0755 -- "$helper" /usr/local/sbin/tomify-agent-activate

# 2. Let the deploying user run that helper, and nothing else, without a password.
rule=$(mktemp)
trap 'rm -f -- "$rule"' EXIT
printf '%s ALL=(root) NOPASSWD: /usr/local/sbin/tomify-agent-activate\n' "$user" > "$rule"
visudo -cf "$rule" >/dev/null || fail 'the sudoers rule did not validate'
install -o root -g root -m 0440 -- "$rule" /etc/sudoers.d/tomify-deploy

# 3. Directories the helper writes into must be root's alone.
mkdir -p /etc/tomify
chown root:root /etc/tomify /etc/systemd/system
chmod go-w /etc/tomify /etc/systemd/system

# 4. Releases belong to the deploying user, who unpacks them without root. The agent
#    already runs as that user, so this grants nothing new.
mkdir -p /opt/tomify/releases
chown "$user:$user" /opt/tomify
chown -R "$user:$user" /opt/tomify/releases
for link in /opt/tomify/current /opt/tomify/previous; do
  [[ ! -L $link ]] || chown -h "$user:$user" "$link"
done

echo "Agent deploys for $user no longer need a password. Undo with: sudo rm /etc/sudoers.d/tomify-deploy /usr/local/sbin/tomify-agent-activate"

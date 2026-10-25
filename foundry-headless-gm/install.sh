#!/usr/bin/env bash
set -euo pipefail

if [[ ${EUID} -ne 0 ]]; then
  echo 'Run install.sh as root on the Foundry host.' >&2
  exit 1
fi
if [[ ! -f /etc/foundry-headless-gm.env ]]; then
  echo 'Missing /etc/foundry-headless-gm.env; refusing to install.' >&2
  exit 1
fi
if ! id foundry-gm >/dev/null 2>&1; then
  echo 'The system user foundry-gm must already exist.' >&2
  exit 1
fi
if [[ $(stat -c '%U:%G:%a' /etc/foundry-headless-gm.env) != 'root:foundry-gm:640' ]]; then
  echo 'The environment file must be owned root:foundry-gm with mode 0640.' >&2
  exit 1
fi
for command in node npm npx systemctl; do
  command -v "$command" >/dev/null || { echo "Missing command: $command" >&2; exit 1; }
done
if [[ ! -x /usr/bin/node ]] || ! /usr/bin/node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo 'Node 22 or newer is required at /usr/bin/node.' >&2
  exit 1
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
target_dir=/opt/foundry-headless-gm
if systemctl is-active --quiet foundry-headless-gm.service; then
  systemctl stop foundry-headless-gm.service
fi
install -d -m 0755 "$target_dir" "$target_dir/lib"
if [[ "$source_dir" != "$target_dir" ]]; then
  for file in package.json package-lock.json headless-gm.mjs README.md foundry-headless-gm.service apparmor-foundry-headless-gm-chromium; do
    install -m 0644 "$source_dir/$file" "$target_dir/$file"
  done
  install -m 0755 "$source_dir/install.sh" "$target_dir/install.sh"
  for file in "$source_dir"/lib/*.mjs; do
    install -m 0644 "$file" "$target_dir/lib/$(basename -- "$file")"
  done
fi
cd -- "$target_dir"
export PLAYWRIGHT_BROWSERS_PATH=/opt/foundry-headless-gm/browsers
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci --omit=dev
npx playwright install --with-deps chromium-headless-shell
# Ubuntu 24.04 sets kernel.apparmor_restrict_unprivileged_userns=1, which breaks
# Chromium's sandbox. Grant userns to this binary only (same shape as the stock chrome profile).
if [[ -d /etc/apparmor.d ]] && command -v apparmor_parser >/dev/null; then
  install -m 0644 "$source_dir/apparmor-foundry-headless-gm-chromium" /etc/apparmor.d/foundry-headless-gm-chromium
  apparmor_parser -r /etc/apparmor.d/foundry-headless-gm-chromium
fi
install -d -o foundry-gm -g foundry-gm -m 0750 /var/lib/foundry-gm
chown -R foundry-gm:foundry-gm /var/lib/foundry-gm
install -m 0644 "$target_dir/foundry-headless-gm.service" /etc/systemd/system/foundry-headless-gm.service
systemctl daemon-reload
systemctl enable foundry-headless-gm.service
systemctl restart foundry-headless-gm.service
systemctl --no-pager status foundry-headless-gm.service

#!/usr/bin/env bash
#
# Register (or unregister) the dsh-kanban bundle in the DSH desktop profile.
#
#   ./install.sh            add the bundle and install dependencies
#   ./install.sh --check    report what would change, write nothing
#   ./install.sh --remove   unregister the bundle again
#
# The plugin lives inside the profile directory (same as dsh-session-metrics and
# dsh-skill-managers), so it is already at the right place. This script registers it in the
# profile's package.json and runs pnpm install, which is what creates the
# `node_modules/dsh-kanban` symlink the Loader resolves the package name through.
#
# It does NOT restart the app. A new bundle row is a composition change, and a composition change
# needs a restart (T-008); the script says so at the end instead of pretending otherwise.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROFILE_DIR="$(dirname "$HERE")"
PROFILE_PKG="$PROFILE_DIR/package.json"
PACKAGE_NAME="$(node -p "require('$HERE/package.json').name")"

MODE=install
case "${1:-}" in
  --check)  MODE=check ;;
  --remove) MODE=remove ;;
  -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) echo "unknown argument: $1" >&2; exit 2 ;;
esac

[ -f "$PROFILE_PKG" ] || { echo "error: no profile package.json at $PROFILE_PKG" >&2; exit 1; }

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$PROFILE_PKG', 'utf8'));
const name = '$PACKAGE_NAME';
const link = 'link:$HERE';
const dep = pkg.dependencies?.[name];
const bundled = (pkg.dsh?.profile?.bundles ?? []).includes(name);
console.log('  profile      $PROFILE_PKG');
console.log('  dependency   ' + (dep === undefined ? '(absent)' : dep) + (dep === link ? '  [ok]' : dep === undefined ? '' : '  [differs]'));
console.log('  bundles      ' + (bundled ? 'lists ' + name + '  [ok]' : 'does not list ' + name));
"

if [ "$MODE" = check ]; then
  echo
  echo "run ./install.sh to apply, or ./install.sh --remove to unregister"
  exit 0
fi

echo "backing up $PROFILE_PKG"
cp "$PROFILE_PKG" "$PROFILE_PKG.bak-$(date +%Y%m%d%H%M%S)"

node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('$PROFILE_PKG', 'utf8'));
const name = '$PACKAGE_NAME';
const link = 'link:$HERE';
const want = '$MODE';

if (want === 'install') {
  pkg.dependencies ??= {};
  pkg.dependencies[name] = link;
  pkg.dsh ??= {};
  pkg.dsh.profile ??= {};
  pkg.dsh.profile.bundles ??= [];
  if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
} else {
  delete pkg.dependencies[name];
  if (pkg.dsh?.profile?.bundles) {
    pkg.dsh.profile.bundles = pkg.dsh.profile.bundles.filter((b) => b !== name);
  }
}

fs.writeFileSync('$PROFILE_PKG', JSON.stringify(pkg, null, 2) + '\n');
console.log((want === 'install' ? 'registered' : 'unregistered') + '  ' + name);
"

if command -v pnpm >/dev/null 2>&1; then
  echo "installing $PROFILE_DIR"
  (cd "$PROFILE_DIR" && pnpm install --prefer-offline) || echo "warning: pnpm install reported a failure; check node_modules/$PACKAGE_NAME below"
else
  echo "warning: pnpm is not on PATH; run the install in $PROFILE_DIR yourself"
fi

if [ -e "$PROFILE_DIR/node_modules/$PACKAGE_NAME" ]; then
  echo "linked       node_modules/$PACKAGE_NAME  [ok]"
else
  echo "PROBLEM: node_modules/$PACKAGE_NAME is missing, so the Loader cannot resolve $PACKAGE_NAME" >&2
  exit 1
fi

echo
echo "done. A new bundle is a composition change, so it loads on the next app restart."

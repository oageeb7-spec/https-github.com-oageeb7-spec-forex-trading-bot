#!/data/data/com.termux/files/usr/bin/bash
# CleanYourTV debloat for a Sony BRAVIA TL2, run from Termux on the TV itself.
#
# Follows https://github.com/Gathin23/cleanyourtv: back up first, then apply
# examples/sony-bravia-tl2/debloat.txt with the project's own tools/disable.sh, which records
# every package's state so tools/restore.sh can put the TV back exactly. Nothing is uninstalled.
# The launcher half is skipped: building it needs a JDK and the Android SDK, which a TV can't run.
#
# Usage (in Termux, USB debugging on):
#   curl -fsSL <this file's raw URL> -o tv.sh && bash tv.sh
set -euo pipefail

# Termux runs on the TV, so the TV is this machine. A fixed address also keeps the restore record
# (~/.cleanyourtv/, named after the address) the same when the router hands out a new IP.
export TV_HOST=127.0.0.1
REPO="${REPO:-$HOME/cleanyourtv}"
LIST="$HOME/bravia-tl2.txt"
STAMP=$(date +%Y%m%d-%H%M%S)
LOCAL_BACKUP="$HOME/tv-backup-$STAMP"
TV_BACKUP="/sdcard/cleanyourtv-backup-$STAMP"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
# Read answers from the keyboard even when the script itself arrives on stdin.
ask() { local a; read -r -p "$1 [y/N] " a </dev/tty || true; [[ $a == [yY]* ]]; }
tv() { "$PY" -I "$REPO/tools/tv.py" "$@"; }

say "1/6  Installing git and Python (a few minutes the first time)"
if [ -z "${SKIP_PKG:-}" ]; then
  pkg install -y git python python-cryptography
fi

say "2/6  Getting CleanYourTV"
if [ -d "$REPO/.git" ]; then
  git -C "$REPO" pull --ff-only --quiet || echo "(could not update; using the copy already here)"
else
  git clone --depth 1 --quiet https://github.com/Gathin23/cleanyourtv "$REPO"
fi
cd "$REPO"
PY="$REPO/tools/venv/bin/python"
if [ ! -x "$PY" ]; then
  # Termux's own cryptography package, not a pip build of it, which needs Rust and takes an hour.
  python -m venv --system-site-packages tools/venv
fi
"$PY" -m pip install --quiet --disable-pip-version-check adb-shell==0.4.4 rsa==4.9.1

say "3/6  Connecting to the TV"
echo "If the TV asks \"Allow USB debugging?\", tick Always allow and choose Allow."
if ! tv --probe; then
  echo
  echo "Could not connect. Check Settings > Device Preferences > Developer options > USB debugging"
  echo "is on, accept the Allow prompt if it showed, then run: bash tv.sh"
  exit 1
fi

say "4/6  Backing up the TV's current setup"
mkdir -p "$LOCAL_BACKUP"
tv "mkdir -p $TV_BACKUP" >/dev/null
backup() {
  local name=$1 cmd=$2
  tv "$cmd" | tr -d '\r' >"$LOCAL_BACKUP/$name.txt"
  tv "$cmd > $TV_BACKUP/$name.txt" >/dev/null
  echo "  saved $name"
}
backup packages-all     'pm list packages -f'
backup packages-enabled 'pm list packages -e'
backup packages-disabled 'pm list packages -d'
backup packages-added   'pm list packages -3'
backup home-app         'cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME'
backup getprop          'getprop'
backup settings-system  'settings list system'
backup settings-secure  'settings list secure'
backup settings-global  'settings list global'
echo "Backup saved twice: in Termux at $LOCAL_BACKUP"
echo "and on the TV's storage at $TV_BACKUP"

say "5/6  Choosing what to switch off"
installed() { grep -qxF "package:$1" "$LOCAL_BACKUP/packages-enabled.txt"; }
{
  echo "# Sony BRAVIA TL2, from CleanYourTV examples/sony-bravia-tl2/debloat.txt, chosen on $STAMP."
  echo "# The stock launcher stays: no replacement launcher is installed from Termux."
} >"$LIST"
for p in fusion.android.tv.demo android.autoinstalls.config.tpv.device \
         com.google.android.feedback com.google.android.play.games; do
  installed "$p" && echo "$p" >>"$LIST"
done
echo "Always switched off (safe on this TV): shop demo, partner auto-installs,"
echo "Google feedback reporter, Play Games."
echo
echo "These are apps the list's author did not use. Answer y only for ones YOU don't use:"
while read -r p name; do
  installed "$p" || continue
  if ask "  Switch off $name?"; then echo "$p" >>"$LIST"; fi
done <<'EOF'
com.amazon.amazonvideo.livingroom Prime Video
com.disney.disneyplus Disney+
com.nousguide.android.rbtv Red Bull TV
com.cg.football the football game
com.goodtoolapps.zeus Zeus
EOF

if ! grep -qv '^#' "$LIST"; then
  echo "Nothing to switch off: everything on the list is already off or not on this TV."
  exit 0
fi
echo
echo "About to switch off:"
grep -v '^#' "$LIST" | sed 's/^/  /'
if ! ask "Go ahead?"; then
  echo "Stopped. Nothing was changed. Run bash tv.sh to start again."
  exit 0
fi

say "6/6  Switching them off"
tools/disable.sh "$LIST"
echo
"$PY" -I tools/check.py "$LIST" || true

cat >"$HOME/restore-tv.sh" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# Puts every package back the way it was before bash tv.sh ran. Needs USB debugging on.
export TV_HOST=127.0.0.1
cd "$REPO" && tools/restore.sh "$LIST"
EOF

say "Done"
echo "To undo everything later: turn USB debugging back on, open Termux and type: bash restore-tv.sh"
echo "Now turn USB debugging OFF: Settings > Device Preferences > Developer options."

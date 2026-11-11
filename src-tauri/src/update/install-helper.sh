pid=$1 src=$2 dest=$3 log=$4 err=$5 backup=$6 helper=$7
mkdir -p "$(dirname "$log")" "$(dirname "$err")"
exec >>"$log" 2>&1
echo "== $(date): installing $src into $dest"
while kill -0 "$pid" 2>/dev/null; do sleep 0.2; done
fail() { echo "FAILED: $1"; printf '%s\n' "Couldn't install the new build ($1). Details in $log" >"$err"; }
if ! "$helper" swap-apps "$src" "$dest"; then
  fail "exchanging the apps; installed app unchanged"
else
  rm -f "$err"
  if ! mv "$src" "$backup"; then backup=$src; fi
  echo "installed; previous version retained at $backup"
fi
if ! open "$dest"; then
  fail "launching the update; restoring the previous app"
  if [ -d "$backup" ]; then "$helper" swap-apps "$backup" "$dest" && open "$dest"; fi
fi

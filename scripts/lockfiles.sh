# Source from repository-root build/check entry points. Preserve a failing command's status,
# and also fail if even a successful tool silently rewrote either committed lockfile.
mosaic_lock_before="$(shasum -a 256 Cargo.lock pnpm-lock.yaml)"
mosaic_check_locks() {
  local status=$?
  local after
  after="$(shasum -a 256 Cargo.lock pnpm-lock.yaml 2>/dev/null)" || status=1
  if [[ "$after" != "$mosaic_lock_before" ]]; then
    echo 'Build/check changed a lockfile. Restore it and update dependencies in a dedicated change.' >&2
    status=1
  fi
  exit "$status"
}
trap mosaic_check_locks EXIT

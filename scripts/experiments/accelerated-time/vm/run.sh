#!/bin/sh
set -eu
mode=${1:?Usage: run.sh baseline-or-accelerated absolute-work-directory}
work_dir=${2:?Provide a directory containing probe.mjs and optional guest.env}
case "$work_dir" in /*) ;; *) echo 'Work directory must be absolute' >&2; exit 2;; esac
test -f "$work_dir/probe.mjs"
# An explicit name lets the host watchdog stop the whole experiment container.
exec docker run --rm --name "${VM_CONTAINER_NAME:-wfgraph-time-vm-$$}" \
    --platform linux/arm64 \
    -e VM_ICOUNT_SHIFT="${VM_ICOUNT_SHIFT:-3}" \
    -e VM_MEMORY_MB="${VM_MEMORY_MB:-2048}" \
    --mount "type=bind,src=$work_dir,dst=/input,readonly" \
    wfgraph-accelerated-time-vm:local "$mode"

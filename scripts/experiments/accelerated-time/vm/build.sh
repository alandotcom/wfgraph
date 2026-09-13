#!/bin/sh
set -eu
vm_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
docker build --platform linux/arm64 -t wfgraph-accelerated-time-vm:local "$vm_dir"

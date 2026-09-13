# Accelerated clock experiment

This standalone experiment runs Node, the real Inngest 1.44.0 server, and
PostgreSQL inside one ARM64 Linux guest. QEMU runs inside an unprivileged Docker
container. It does not change the host clock or connect to the development database.

Build the VM image, then compare the two modes:

```sh
sh scripts/experiments/accelerated-time/vm/build.sh
pnpm run test:clock-experiment
```

Docker must be running. The initial image build downloads the guest kernel,
PostgreSQL, and a checksum-verified Inngest binary. Node and Alpine base images
are pinned by digest; APK package versions can change on a later rebuild. The
guest prints its installed versions into the captured log.

`baseline` uses ordinary QEMU guest time. `accelerated` uses single-threaded TCG
instruction counting with `sleep=off`, allowing virtual time to jump to a timer
deadline while the virtual CPU is idle. This is not a fixed clock multiplier.
Neither mode uses hardware virtualization, and both include emulation overhead.

Run one mode with `pnpm run test:clock-experiment baseline` or
`pnpm run test:clock-experiment accelerated`. `VM_ICOUNT_SHIFT=3` is the default;
larger shifts advance more virtual nanoseconds per guest instruction and can
change workload behavior. Do not interpret the shift as a speedup factor.

## What the probe checks

- Node's wall clock, monotonic clock, and PostgreSQL `clock_timestamp()` advance
  through a five-second Node timer. PostgreSQL time stays inside the Node
  timestamps bracketing each query, with a 20 ms allowance.
- PostgreSQL `now()` remains fixed within a transaction while `pg_sleep(1)` and
  `clock_timestamp()` advance.
- A real Inngest durable sleep waits at least five guest seconds.
- An intentionally failed step retries once, at least one guest second later.
- A callback waits 35 guest seconds, longer than Inngest 1.44.0's 30-second queue
  item lease, and its side effects occur once.
- All three Inngest runs reach `COMPLETED` before shutdown.

The host timestamps serial output independently and enforces a four-minute
watchdog per mode. SIGINT and SIGTERM remove only that run's named container.
Evidence goes under `test-results/clock-experiment/<timestamp>/`: full console
logs, correctness results, host-observed intervals, and a comparison when both
modes run. Console receipt times include output buffering and are approximate
measurements. A correctness PASS does not itself establish a speedup.

## Limits

This fixture tests the SDK, durable engine, and database directly. It is not the
Workflow Graph application and is not a replacement for `test:reliability`.
It does not yet test event-versus-timeout races, fault recovery during lease
renewal, or other database engines. A single paired run is a feasibility result,
not a benchmark distribution. Any speedup is relative to the same QEMU baseline,
not the native reliability suite.

See [the clock research](../../../docs/internal/reliability-clock-research.md)
for source references and the alternatives considered.

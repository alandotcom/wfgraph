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

PR Checks runs both modes sequentially on an `ubuntu-24.04-arm` runner. The
`clock-experiment` artifact contains the logs and JSON measurements, including
failure evidence. CI checks correctness without requiring a minimum speedup.

## Run the existing reliability suite

```sh
pnpm run test:clock-experiment accelerated reliability
```

This workload boots one VM and runs the three existing reliability test files
against both SQLite and PostgreSQL. It uses the original Vitest configuration:
three isolated fork workers, unchanged assertions and deadlines. The campaign
uses `WFGRAPH_RELIABILITY_RUNS=5` and seed `424242`, configuring 50 scenarios
including fixed examples. Failures stop a property and trigger its normal replay
and shrinking.

Preparation bundles the checkout's tests and application dependencies, then
installs Linux Vitest and Vite at the checkout's installed versions using pnpm.
The existing lockfile supplies dependency resolutions; the reduced importer is
regenerated. Bundles are loaded as native modules through small test entrypoints
to avoid transforming application dependencies again inside the guest. The work
directory and its generated lockfile are retained with the results.

The reliability workload defaults to 4 GB guest memory and a ten-minute host
watchdog. Reported host time starts after preparation and includes packaging,
boot, service startup, test execution, artifact export, and shutdown. A separate
`suite` interval measures the time between the guest starting and finishing
Vitest. Vitest's own durations use the guest clock, so use the host measurements
for speed comparisons.

Artifacts include `accelerated-vitest-results.json`, the full serial transcript,
and the original failure evidence for any failed properties. A pass requires all
six Vitest properties to pass. The VM's 50-scenario configuration matches this
native command:

```sh
WFGRAPH_RELIABILITY_RUNS=5 WFGRAPH_RELIABILITY_SEED=424242 \
  WFGRAPH_RELIABILITY_BACKEND=all pnpm run test:reliability
```

The native command also needs `WFGRAPH_TEST_DATABASE_URL`. The VM provisions its
own PostgreSQL. Bundling, operating system, and database versions can differ
between native and guest runs; retain those differences when interpreting the
comparison. Current CI continues to run the smaller clock probe.

## Limits

The default probe tests the SDK, durable engine, and database directly. It is not the
Workflow Graph application and is not a replacement for `test:reliability`.
It does not yet test event-versus-timeout races, fault recovery during lease
renewal, or other database engines. A single paired run is a feasibility result,
not a benchmark distribution. The default probe compares QEMU modes; the reliability workload can be compared
with a separately timed native suite.

See [the clock research](../../../docs/internal/reliability-clock-research.md)
for source references and the alternatives considered.

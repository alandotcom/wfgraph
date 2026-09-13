# Accelerated time for full-stack reliability tests

Research status: an initial all-in-guest QEMU probe is implemented and measured.
It is separate from the Workflow Graph reliability suite.
Inspected the installed Inngest CLI 1.44.0, commit
`a54673a45b00ea10917620ab3e05a21d04579db7`.

## Which clocks must agree?

The test runner initiates operations through the Node application. Node computes
Wait deadlines and stores them; Inngest schedules durable work against those
deadlines. PostgreSQL supplies some timestamps and duration calculations, and
Inngest's embedded Redis maintains expiry state. Accelerating only Node would
leave the scheduler and database on different timelines.

Local evidence:

- [Wait preparation](../../packages/core/src/backend/engine/wait-event.ts) uses
  `new Date()` and `Date.now()` to derive the absolute deadline and remaining wait.
- [Wait claims](../../packages/core/src/backend/services/executions/repo/waits.ts)
  derive lease cutoffs in Node.
- [PostgreSQL schema defaults](../../packages/core/src/backend/lib/db/schema.ts)
  use `now()`, and [run completion](../../packages/core/src/backend/services/executions/repo/runs.ts)
  calculates duration in SQL.
- The [SQLite execution implementation](../../packages/core/src/backend/persistence/sqlite/executions/)
  writes timestamps from Node. SQLite's own SQL `now` is a separate VFS time source
  if used; being in-process does not automatically make Vitest's Date replacement
  control native SQLite time.

PostgreSQL's `now()` is intentionally fixed at transaction start; `clock_timestamp()`
reads current server time. Any test clock must preserve that distinction, rather
than replacing every SQL time expression with a moving value.
[PostgreSQL semantics](https://www.postgresql.org/docs/current/functions-datetime.html),
[SQLite semantics](https://www.sqlite.org/lang_datefunc.html).

## Existing Inngest support

There is a useful starting point for an instrumented test build:

- The [executor supports WithClock](https://github.com/inngest/inngest/blob/a54673a45b00ea10917620ab3e05a21d04579db7/pkg/execution/executor/executor.go#L438).
- The [queue supports WithClock](https://github.com/inngest/inngest/blob/a54673a45b00ea10917620ab3e05a21d04579db7/pkg/execution/queue/option.go#L362).
- The [dev server](https://github.com/inngest/inngest/blob/a54673a45b00ea10917620ab3e05a21d04579db7/pkg/devserver/devserver.go#L347)
  supplies a real clock to its constraint manager. Its embedded Redis expiry
  advances through a [real-time ticker calling FastForward](https://github.com/inngest/inngest/blob/a54673a45b00ea10917620ab3e05a21d04579db7/pkg/devserver/devserver.go#L838).
- Miniredis separates TTL advancement (`FastForward`) from its time origin
  (`SetTime`); updating one does not substitute for controlling both.
  [Vendored implementation](https://github.com/inngest/inngest/blob/a54673a45b00ea10917620ab3e05a21d04579db7/vendor/github.com/alicebob/miniredis/v2/miniredis.go).

These hooks do not constitute full-server virtual time. Direct real-time reads
remain, including in [pause expiry](https://github.com/inngest/inngest/blob/a54673a45b00ea10917620ab3e05a21d04579db7/pkg/execution/state/redis_state/pause_store.go)
and [queue processing](https://github.com/inngest/inngest/blob/a54673a45b00ea10917620ab3e05a21d04579db7/pkg/execution/queue/process.go).
The installed CLI exposes retry interval and queue polling controls, but no
clock-rate or advance-time option. Lowering `--tick` changes polling frequency,
not the meaning of a second.

## Platform approaches

| Approach                            | Finding                                                                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux time namespaces               | Fixed monotonic/boottime offsets, not rate acceleration; realtime is not virtualized. Insufficient by itself.                                                                                          |
| libfaketime                         | Supports rate multipliers for intercepted calls, but Go can bypass libc through runtime/vDSO paths. Not a reliable whole-stack switch for the shipped Inngest binary.                                  |
| QEMU system emulation with `icount` | A candidate for putting Node, Inngest, and PostgreSQL under guest virtual time. Idle clock advancement can skip waits, but instruction-counted time is not a guaranteed fixed multiplier of host time. |

Sources: [Linux time namespaces](https://man7.org/linux/man-pages/man7/time_namespaces.7.html),
[libfaketime](https://github.com/wolfcw/libfaketime/blob/master/README),
[Go time implementation](https://go.dev/src/runtime/time_linux_amd64.s?m=text),
[QEMU instruction counting](https://www.qemu.org/docs/master/devel/tcg-icount.html),
[QEMU system options](https://www.qemu.org/docs/master/system/qemu-manpage.html).

QEMU is an experiment, not a demonstrated speedup for this suite. Emulation
overhead, its TCG threading constraints, guest wall-clock behavior, and external
network traffic need measurement. The application, Inngest, and database must all
live inside the guest; a database on the host would retain real time.

## CI startup and VM reuse

The first CI run gives a useful startup breakdown. In the accelerated run,
`VM_READY` arrived at 33.39 seconds, `primitive-start` at 38.59 seconds,
`engine-ready` at 46.01 seconds, and the complete probe at 67.08 seconds; the
whole process took 67.67 seconds. The ordinary QEMU baseline reached `VM_READY`
at 27.26 seconds and took 85.51 seconds overall. `VM_READY` is emitted after the
launcher has packaged the guest, the kernel has booted, and PostgreSQL has been
initialized and started. It is not a kernel-boot-only measurement.

One experiment can amortize guest boot and PostgreSQL startup across the whole
reliability corpus. Stage the existing suite before boot and execute it inside
one guest. Keep the harness's existing per-scenario application and Inngest
instances so that scenario isolation remains unchanged. This needs no live
host-to-guest control channel. Reusing Inngest between scenarios would be a
separate change requiring a proven reset boundary.

The current [launcher](../../scripts/experiments/accelerated-time/vm/launch)
copies the per-run input into `/guest` and compresses the entire tree into one
initramfs archive. A base archive can be generated during the image build, then
the launcher can append a small per-run archive containing `/work`. The Linux
kernel accepts a sequence of compressed or uncompressed cpio archives in one
initramfs buffer, and a `TRAILER!!!` marker permits independently generated
archives to be concatenated. This should remove repeated packaging of the
immutable guest files; it still needs a measurement because decompression and
guest boot remain.
[Linux initramfs buffer format](https://docs.kernel.org/driver-api/early-userspace/buffer-format.html)

A booted QEMU snapshot is possible, but the clock state needs a proof. QEMU's
documented snapshot path for instruction-counted execution is attached to
record/replay: `rrsnapshot` creates a starting snapshot and replay restores it
at the recorded point. The QEMU QMP reference exposes an `icount` field for a
snapshot only when record/replay is enabled. That does not establish that a
generic `savevm`/`loadvm` cycle preserves the ordinary `-icount shift=...`
clock used by this experiment. A snapshot taken after all services are ready
could remove boot work, but it would need a probe for restored monotonic time,
timers, PostgreSQL, and Inngest state. QEMU's fast snapshot-load implementation
uses Linux `userfaultfd` and is Linux-only, which also needs checking inside the
GitHub runner's Docker environment.
[QEMU record/replay snapshots](https://www.qemu.org/docs/master/system/replay.html)
[QEMU QMP snapshot state](https://www.qemu.org/docs/master/interop/qemu-qmp-ref.html)
[QEMU fast snapshot load](https://www.qemu.org/docs/master/devel/migration/fast-snapshot-load.html)

Hardware virtualization is unlikely to be a dependable option on the hosted
runner. GitHub currently documents `ubuntu-24.04-arm` as a four-vCPU, 16-GB
ARM64 Linux runner for public repositories, but separately says nested VMs are
technically possible and officially unsupported. QEMU KVM or Firecracker could
reduce ordinary boot and execution costs only where nested KVM actually works;
they do not provide QEMU's instruction-counted virtual clock. Firecracker's
official design documents that vCPUs run through `KVM_RUN` and that AArch64
guests use `arch_sys_counter`, while its snapshot support is optimized for fast
resume. That makes Firecracker a possible self-hosted KVM boot optimization,
but not a drop-in accelerated-clock engine for this test.
[GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)
[GitHub nested virtualization note](https://docs.github.com/en/actions/concepts/runners/github-hosted-runners)
[Firecracker design](https://github.com/firecracker-microvm/firecracker/blob/main/docs/design.md)
[Firecracker snapshots](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)

Docker layer caching can remove repeated image-build work in CI. Docker's GitHub
Actions cache backend supports `cache-from: type=gha` and
`cache-to: type=gha,mode=max`, so the kernel, PostgreSQL, and Inngest download
layers can be reused between workflow runs. This caches BuildKit image layers;
it does not cache the running VM, initramfs packaging performed by `launch`, or
the guest's PostgreSQL/Inngest startup. It is useful alongside the boot changes,
not a substitute for them.
[Docker GitHub Actions cache backend](https://docs.docker.com/build/cache/backends/gha/)

## Assessment

Two approaches merit a small proof before a harness redesign:

1. An all-in-guest QEMU environment, to test whether an unmodified stack can
   advance through waits coherently and faster overall.
2. A test build of Inngest using its existing clock hooks, extended to cover the
   remaining scheduler, lease, and expiry paths, coordinated with explicit Node
   and PostgreSQL time control. The PostgreSQL mechanism is still unresolved;
   a Node fake clock alone is not sufficient.

For either approach, first verify clock readings, timer wakeups, retry spacing,
lease renewal, Redis expiry, and PostgreSQL transaction-time behavior against an
external real-time observer. Boot the stack before accelerating it. Keep a
real-time watchdog outside the accelerated environment.

A five-second durable sleep and an event racing its timeout would make useful
initial probes. Start with modest acceleration and check that the same outcomes
occur. Faster clocks also shorten the real time available to renew leases and
complete I/O; CPU and database work do not become faster merely because time does.

Explicitly advancing to the next deadline could eventually outperform a constant
rate multiplier, but requires knowing that relevant work has finished and all
components are ready for the advance. Existing per-component fake clocks do not
provide that distributed readiness guarantee.

These source-level findings do not predict the end-to-end speedup for the
current 50-scenario suite. Standalone measurements follow.

## Initial QEMU result

The [standalone experiment](../../scripts/experiments/accelerated-time/README.md)
runs Node 24.16.0, PostgreSQL 17.11, and Inngest 1.44.0 in one ARM64 Linux guest
under QEMU 10.0.0. The host enforces its own watchdog and timestamps serial output.
The accelerated mode uses `-icount shift=3,align=off,sleep=off`; the baseline uses
the same guest and ordinary QEMU time.

One paired run on the local ARM64 Mac with OrbStack produced:

| Host-observed interval                     | QEMU baseline | QEMU accelerated |
| ------------------------------------------ | ------------: | ---------------: |
| Five-second Node timer                     |        5.02 s |          0.025 s |
| Five-second durable sleep                  |        5.34 s |           2.06 s |
| 35-second callback                         |       35.06 s |           5.38 s |
| Whole run, including VM setup and shutdown |       56.57 s |          25.91 s |

Both runs passed the clock-agreement assertions, PostgreSQL transaction-time
checks, one-time retry, and single-execution checks for the callback exceeding
the queue's 30-second lease. All three Inngest runs reached `COMPLETED` before
shutdown. This exercises lease renewal but does not instrument renewal counts or
inject failures during renewal. A separate SIGINT check left no experiment
container running.

Local raw evidence is under
`test-results/clock-experiment/2026-09-13T01-53-56.167Z/`. These are serial-receipt
measurements from one pair, not exact CPU timings or a statistical benchmark.
The speedup is relative to the emulated baseline, not native execution. The
large difference between the idle timer and real workflow results shows why
clock advancement alone cannot predict the suite's speedup.

The result supports further experiments with real engine time acceleration.
It does not establish the speed or reliability of moving the full Workflow
Graph suite into the VM; event/timeout races and broader failure coverage remain
to be tested.

## Full reliability suite comparison

The next experiment ran the existing three reliability test files with seed
`424242`, five generated cases per property, both database backends, and the
original three-worker Vitest configuration. Fixed examples bring a successful
campaign to 50 scenarios across six property groups. The VM booted once; each
scenario retained its existing application, database isolation, and Inngest
lifecycle. Assertions and deadlines were unchanged.

The native run used Node 24.16.0, PostgreSQL 17.10, and Inngest 1.44.0 on the
ARM64 Mac. It passed all six property groups in 49.43 seconds of host time.
The accelerated guest used Node 24.16.0, PostgreSQL 17.11, Inngest 1.44.0,
4 GB RAM, and the existing single-vCPU `icount shift=3` configuration. It
finished unsuccessfully after 231.85 host seconds, with one property group
passing and five failing. The suite started at 20.60 seconds and ran for
210.62 seconds.

The saved failure artifacts report Inngest health timeouts against the
unchanged 30-second guest-clock deadline. Reproduction and shrinking can
replace earlier scenario evidence, so these artifacts do not prove that every
initial failure had that cause. The failed campaign includes reproduction and
shrinking work; its elapsed time cannot establish a speed ratio for completing
all 50 scenarios. It does show that this setup did not produce a faster,
successful run of the existing suite.

The guest runs compiled copies of the original tests through Vitest, with
small discovery files importing the bundles as native dependencies. This
avoids asking Vite to transform all bundled application dependencies again.
Preparation, including bundling and installation of the Linux Vitest toolchain,
is outside the measured VM launch interval. Native PostgreSQL was already
running, while the VM timing includes PostgreSQL setup. The comparison evaluates
the practical configurations, not the isolated cost of instruction counting:
the native suite can use multiple host CPUs while the guest has one vCPU.

Raw evidence is in `test-results/full-suite-clock/native-node24.{json,log}` and
`test-results/clock-experiment/2026-09-13T22-22-25.802Z/`. The latter contains
the guest's Vitest report, five failure artifacts, and host-clock observations.

As a packaging control, the exact compiled test bundles were then run natively
with the host's Vitest toolchain and Inngest binary under Node 24.16.0. All six
property groups passed in 47.82 seconds. This supports attributing the failed
comparison to the guest setup rather than changed test bodies. Control evidence
is in `test-results/full-suite-clock/native-payload-control.{json,log}` and
`test-results/full-suite-clock/native-payload/vitest-control-results.json`.

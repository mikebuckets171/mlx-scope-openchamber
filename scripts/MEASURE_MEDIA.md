# CPU-only media overhead measurement

This development harness starts only synthetic loopback sources in a temporary HOME. It never submits generation, downloads a model, cancels a real job, or restarts an application. The production bundle must already be built. Use an immutable copy to retain exact evidence.

The workload contains four media sources, four simultaneous views, and 73 input records, exercising the 64-job response bound. Active/glance media polling is every two seconds; terminal-only idle polling is every five seconds. Runtime polling is 500 ms active, two seconds idle, and one second glance. It measures 30-second steady windows and 75 seconds hidden after settling. CPU percentages are fractions of one core, including service children. Ceilings are unchanged: 1.9% active, 0.68% idle/glance, 132 MiB service RSS.

## Exact child accounting on macOS

Compile the measurement-only wrapper outside the repository and verify its process contract:

```sh
measurement_dir=$(mktemp -d)
clang -std=c11 -Wall -Wextra -Werror -O2 scripts/lib/child-rusage.c -o "$measurement_dir/child-rusage"
node scripts/lib/test-child-rusage.mjs "$measurement_dir/child-rusage"
node scripts/measure-media-overhead.mjs \
  --service /absolute/path/to/frozen/service/main.js \
  --child-rusage-wrapper "$measurement_dir/child-rusage" \
  --out /absolute/path/to/media-overhead.json
rm -rf "$measurement_dir"
```

The wrapper preserves arguments, environment, working directory, standard output/error, exit status, and handled signals. It uses `wait4` to measure each command's user/system CPU and includes its own measured CPU. The harness also conservatively includes any positive residual from the whole-run CPU cross-check, covering final wrapper logging/exit overhead and time-tool rounding.

Every spawned command must have exactly one matching finite native record. The receipt requires no command to straddle a phase boundary, retains original executable basenames, and checks whole-run agreement within 0.025 seconds. CPU is attributed to the command's completion phase. The wrapper, its source/test, and the measurement scripts are development files; they are not extension assets or a required native collector.

Without `--child-rusage-wrapper`, the harness retains the older pooled method: commands missed by 500 ms process sampling share aggregate child CPU evenly per spawn. That estimate can assign the cost of expensive full-view probes to cheap glance probes. Compare methodology as well as bundle hashes when reading receipts; do not silently replace earlier failures or change the ceilings.

The helper measurement uses a CPU-only Python registry/queue fixture. Its RSS is the fixture process, not additional ComfyUI RSS. Renderer/native-host CPU, GPU work, power use, and inference slowdown need separate evidence. No result from this harness establishes enabled/disabled inference impact.

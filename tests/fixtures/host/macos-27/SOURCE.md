# Host telemetry fixtures · macOS 27

**What this folder is:** exact stdout (or stderr, where stated) of the fixed, read-only host probes that MLX Scope 2.0 runs.
The probes are listed in `docs/2.0/SPIKES.md` (S9 and the G1 exec freeze) and `docs/design/2.0-contract.md` §8. There is one
file per variant, named `<command>.<variant>.txt`. The bytes are what the Stage 5 host adapters should see through
`service/native-command.ts` `readCommand`: no shell, `LANG=C`, `LC_ALL=C`, stdout only.

**Version represented:** macOS 27.2 on Apple Silicon. The live reference runs were on an M5-generation Mac, which is why the
`vm_stat` memory-tagging (MTE) block and the `AGXAcceleratorG17X` node appear. `macmon` is not installed on that Mac, so its
files are synthesized from upstream source only: v0.8.2, plus v0.7.2 for the legacy variant.

**Synthetic only.**
- Every number that describes the machine's activity has been replaced: counts, bytes, utilisation, watts, temperatures, dates
  and registry ids.
- There are no paths, usernames, hostnames, model ids, keys or prompt text.
- The only process name is the generic `python3` that an oMLX listener runs as.
- The live runs were used to learn byte layouts only. Where a live layout was kept, the "Provenance" line says so.

## Privacy canaries

| Canary | Planted in | Why it is there |
|---|---|---|
| PID `4242` | `ioreg.idle.txt`, `ioreg.busy.txt`, `ioreg.oversize.txt` and `ioreg.truncated.txt` (`"AGCInfo" = {"fLastSubmissionPID"=4242,…}`, which comes before the cut); `lsof.listening.txt`; `lsof.multiple.txt`; every `footprint.*` header (`python3 [4242]`); `footprint.not-found.txt` (`matching '4242'`) | Contract §9, class A: PIDs never go on the wire, into receipts or into Copy. The adapter tests must prove `4242` never leaves the service. |
| PID `4243` | `lsof.multiple.txt` (second listener) | Same rule. A second listener also makes the PID ambiguous, so the adapter must skip `footprint` rather than pick one. |

Nothing else in this folder is class A. Model names (class B) do not appear at all.

## `/usr/bin/vm_stat`

| File | stdout · exit | Variant |
|---|---|---|
| `vm_stat.normal.txt` | stdout · 0 | Steady state on an MTE Mac with 16 KiB pages. It includes the 11 tag lines that only MTE hardware prints. |
| `vm_stat.no-mte.txt` | stdout · 0 | The same OS on a Mac without MTE (M1–M4 class): the tag block is absent. Parsers must not require it. |
| `vm_stat.pressure.txt` | stdout · 0 | Memory pressure: free pages near zero, compressor and wired pages high, swap-outs climbing. Pairs with `sysctl.pressure-4.txt`. |

**Provenance**
- Synthesized from `apple-oss-distributions/system_cmds@system_cmds-1042.120.1` (`15832a892bdd86cf3e3f2fde9265142f714437c8`),
  `vm_stat/vm_stat.c`:
  - `:140-182`, `snapshot()`: the label order; the MTE block is at `:167-181`;
  - `:185-188`, `sspstat`: `"%-35s %16llu.\n"`, so every value line is exactly 53 characters.
- The layout matched a live macOS 27.2 run line for line. All counts are synthetic.
- The page size comes from the header, never assumed. Wired bytes = `Pages wired down` × 16384.

## `/usr/sbin/sysctl -i vm.swapusage kern.memorystatus_vm_pressure_level kern.memorystatus_level iogpu.wired_limit_mb`

| File | stdout · exit | Variant |
|---|---|---|
| `sysctl.all-keys.txt` | stdout · 0 | All four keys. Pressure level `1` (normal); no swap file yet (`total = 0.00M`); wired limit `40960` MB. |
| `sysctl.pressure-2.txt` | stdout · 0 | Pressure `2` (warning), swap in use. |
| `sysctl.pressure-4.txt` | stdout · 0 | Pressure `4` (critical), swap nearly full. |
| `sysctl.missing-key.txt` | stdout · 0 | `iogpu.wired_limit_mb` unknown to the kernel. With `-i` it is dropped silently, and the other keys still print (plan §5.4 test). |
| `sysctl.wired-limit-default.txt` | stdout · 0 | `iogpu.wired_limit_mb: 0`. `0` means "not set, macOS default limit", **not** a 0-byte limit, so `wiredLimitBytes` must be absent. |

**Provenance**
- Synthesized from the same `system_cmds` tag, `sysctl/sysctl.c`:
  - `:229-230`: `-i` sets `iflag`;
  - `:483-488`: with `iflag`, an unknown oid returns 0 with no output;
  - `:1010-1024`, `S_xswusage`: always MiB, two spaces between fields, `(encrypted)`.
- Checked live on macOS 27.2:
  - output order follows argv order;
  - with `-i`, a missing key is omitted and the exit status stays 0;
  - without `-i`, it prints `sysctl: unknown oid` on stderr and exits 1.
- Pressure values `1`/`2`/`4` map to the contract §4 labels normal / warning / critical. Any other value is left out.

## `/usr/sbin/ioreg -r -d 1 -w 0 -c IOAccelerator`

| File | stdout · exit | Variant |
|---|---|---|
| `ioreg.idle.txt` | stdout · 0 | About 45 KB, one node. `PerformanceStatistics` at idle: Device 4 %, Renderer 4 %, Tiler 1 %, Alloc 28 GiB, In use 1 GiB. The scheduler queues are empty. |
| `ioreg.busy.txt` | stdout · 0 | The same node during decode: Device **87 %**, Renderer 85 %, Tiler 12 %, Alloc 31 GiB, In use 18 GiB. The scheduler state is populated. |
| `ioreg.truncated.txt` | (cut) | `ioreg.busy.txt` cut mid-number: it ends with `"Device Utilization %"=8`, with no closing brace and no newline. A parser that does not require the closed `{…}` would read 8 % instead of 87 %. `readCommand` never returns a partial read, so this guards any streaming or capped reader. |
| `ioreg.oversize.txt` | stdout · 0 | A complete, valid node of 132,255 bytes, just over the 128 KiB (131,072-byte) cap in contract §8. The legend is repeated three times, a synthetic stand-in for a larger chip or a future driver. The reader must reject it as oversize and never parse a prefix. |
| `ioreg.no-match.txt` | stdout (empty) · 0 | No `IOAccelerator` class matched. `ioreg` prints nothing and still exits 0 (verified live). |

**Provenance**
- The printer is `apple-oss-distributions/IOKitTools@IOKitTools-125` (`e6f4aac8b42e65f7e76009227de1d05057228488`),
  `ioreg.tproj/ioreg.c`:
  - `:967-1033`: node header `<class …, id 0x…, registered, matched, active, busy …, retain …>`;
  - `:1041-1068`: property block braces and the trailing blank indent line;
  - `:1110-1116`: `+-o`.
- The property set belongs to the closed-source AGX driver. These files are therefore **modeled on a live capture**
  (macOS 27.2, `AGXAcceleratorG17X`, "Apple M5 Pro").

**Scrubbing**
- Replaced:
  - the registry id and busy time;
  - all of `SchedulerState` (empty queues when idle; synthetic stamps when busy);
  - `AGCInfo`: `fLastSubmissionPID` became the canary `4242`, and the counters are synthetic;
  - every `PerformanceStatistics` value;
  - the three `AGXParameterBufferMaxSize*` values (activity high-water marks);
  - one opaque 20-hex `IOReportSubGroupName`, now `5f1c0a9e3b7d2e8f4a60`.
- Kept verbatim: static driver and personality keys, and `IOReportLegend`, which is about 43 KB of fixed driver metadata
  (channel ids and group names) with no host identifiers. It keeps the file at a realistic size.

**Traps kept on purpose**
- `"In use system memory (driver)"=0` comes before `"In use system memory"=…`, so a prefix match reads the wrong value.
- `IOReportLegend` repeats `"Alloc system memory"` and `"In use system memory"` as channel **names**, not assignments.
- `SchedulerState` and `AGXParameterBufferMaxSize` hold integers above 2^53.
- Key order was identical across three consecutive live reads, but IOKit does not guarantee it.

**Labels (SPIKES S9, G1).** "GPU busy (driver-reported)". Alloc and In use are "GPU memory (driver-reported, not model
size)". No alert of any kind is driven by them.

## `/usr/bin/notifyutil -g com.apple.system.thermalpressurelevel`

| File | stdout · exit | Variant |
|---|---|---|
| `notifyutil.level-0.txt` | stdout · 0 | `0` Nominal → "Normal" |
| `notifyutil.level-1.txt` | stdout · 0 | `1` Moderate → "Moderate" |
| `notifyutil.level-2.txt` | stdout · 0 | `2` Heavy → "Heavy" (the warning threshold) |
| `notifyutil.level-3.txt` | stdout · 0 | `3` Trapping → "Severe" |
| `notifyutil.level-4.txt` | stdout · 0 | `4` Sleeping → "Critical" |
| `notifyutil.failed.txt` | stdout · 0 | `notifyd` unreachable: `…: Failed with code 9` (`NOTIFY_STATUS_SERVER_NOT_FOUND`). It is printed on **stdout** with exit 0, so it must be matched as a failure, not parsed as a level. |
| `notifyutil.out-of-range.txt` | stdout · 0 | Defensive, not observed on macOS: `30`, from the non-macOS scale in the same header. It is outside 0–4 and must be dropped. |

**Provenance**
- Synthesized from `apple-oss-distributions/Libnotify@Libnotify-348.120.4` (`227c145bcf26ec93e18304ba81306a3014d9bd56`),
  `notifyutil/notifyutil.c`:
  - `:708-729`: `-g`, with success `"%s %llu\n"` at `:727` and failure `"%s: Failed with code %d\n"` at `:728`;
  - `:753`: exit 0.
- Level meanings are in `MacOSX26.0.sdk/usr/include/libkern/OSThermalNotification.h:46-61`: macOS 0–4; other platforms
  0/10/20/30/40/50. Status codes are in `usr/include/notify.h:81-93`.
- Live on macOS 27.2: `com.apple.system.thermalpressurelevel 0`. `-g` on a key that was never posted also prints `0`.

## `/usr/sbin/lsof -nP -iTCP:8001 -sTCP:LISTEN -t`

| File | stdout · exit | Variant |
|---|---|---|
| `lsof.listening.txt` | stdout · 0 | One listener: `4242`. |
| `lsof.multiple.txt` | stdout · 0 | Two processes hold the listening socket (a parent and a forked worker): `4242`, `4243`. The owner is ambiguous, so skip `footprint`. |
| `lsof.empty.txt` | stdout (empty) · **1** | Nothing listening. Exit 1, so `readCommand` returns `null`. |

**Provenance**
- Synthesized from `apple-oss-distributions/lsof@lsof-76` (`7a8a1b2a3c0f35c30a5fcd0927f31d441c3e5255`):
  - `lsof/main.c:880-881`: `-t` means terse;
  - `lsof/proc.c:1148-1160`: `printf("%d\n", pid)`, with repeated PIDs dropped.
- The shape and exit status (0 with a listener, 1 without) were checked live; the PID was replaced.

## `/usr/bin/footprint -p <pid>` (and `--noCategories`)

| File | argv · stream · exit | Variant |
|---|---|---|
| `footprint.loaded.txt` | `-p 4242` · stdout · 0 | An oMLX-like `python3` listener with a model resident. Footprint `19 GB`, peak `20 GB`; the model sits in the `IOAccelerator` row. |
| `footprint.unloaded.txt` | `-p 4242` · stdout · 0 | The same process after unload: footprint `275 MB`, while `phys_footprint_peak` still says `20 GB`. Peak is not current. |
| `footprint.no-categories.txt` | `--noCategories -p 4242` · stdout · 0 | The loaded state, header plus `Auxiliary data` only. This is the cheap form to parse. |
| `footprint.no-categories-bytes.txt` | `--noCategories -f bytes -p 4242` · stdout · 0 | The same state in exact bytes: `20008894464 B`, peak `21082685440 B`, both whole 16 KiB pages. Formatted mode rounds to `19 GB`. Use this only if Stage 5 allowlists `-f bytes`. |
| `footprint.not-found.txt` | `-p 4242` · **stderr** · **66** | The process is gone, or belongs to another user without root; both print the same message. stdout is empty. |

**Provenance**
- `footprint` is closed source. The layout comes from live runs on macOS 27.2 against an oMLX `python3` listener, and from
  `footprint -h`. The PID and all numbers were replaced.
- Formatted units are whole numbers, rounded, and move to the next unit at or above about 10 × 1024 of the current one.
  This was observed live across several processes: four-digit KB values stay in KB, and larger values print in MB, then GB.
  The fixtures avoid the boundary band (about 9.7–10 × 1024).
- Only the header `Footprint:` and the two `Auxiliary data` lines are meant to be parsed. The category rows are
  illustrative; the column widths are copied from the live table.
- The PID must be re-verified with `ps -o lstart=` before reading (SPIKES S9).

## `/bin/ps -o lstart= -p <pid>`

| File | stdout · exit | Variant |
|---|---|---|
| `ps.normal.txt` | stdout · 0 | `Tue Sep 29 08:15:42 2026`, padded to 28 characters, then a newline. |
| `ps.single-digit-day.txt` | stdout · 0 | `Thu Oct  1 09:05:07 2026`: `%e` pads the day with a space, which gives a double space. |
| `ps.not-found.txt` | stdout (empty) · **1** | The PID no longer exists. |

**Provenance**
- Synthesized from `apple-oss-distributions/adv_cmds@adv_cmds-237` (`6bed8737a34dbb54782a18f47dccf933a9967a12`):
  - `ps/print.c:681-693`, `lstarted`: `strftime("%c")`, then `printf("%-*s")`;
  - `ps/keyword.c:126`: `lstart` has width 28.
- In the C locale, `%c` is `%a %b %e %H:%M:%S %Y`. The value is local time with no zone, so compare it as an opaque string
  (same PID + same string = same process).
- The trailing padding and the empty output with exit 1 were checked live.

## `/opt/homebrew/bin/macmon pipe -i 1000` (NDJSON, one object per line)

| File | stdout · exit | Variant |
|---|---|---|
| `macmon-pipe.normal.txt` | stdout · streaming | Three 1 s samples, v0.8.2, during decode. Every power field is present: `cpu_power`, `gpu_power`, `ane_power`, `all_power` = CPU+GPU+ANE, `sys_power` ≥ `all_power`, `ram_power` and `gpu_ram_power`. It also has `temp`, `gpu_active_ratio`, per-core arrays, two fans, and the v0.7 alias fields. |
| `macmon-pipe.sys-power-zero.txt` | stdout · streaming | Two idle samples on a Mac where SMC key `PSTR` can't be read: `"sys_power":0.0`. Show `sysW` only when > 0. One fan. |
| `macmon-pipe.legacy.txt` | stdout · streaming | The same three samples as v0.7.2 printed them: tuple fields `ecpu_usage`/`pcpu_usage`/`gpu_usage` `[MHz, ratio]` and `cpu_usage_pct`. There are no `*_ratio` fields, per-core arrays or `fans`. The power and `temp` fields are unchanged. |
| `macmon-pipe.partial-line.txt` | stdout · (cut) | Two complete lines, then a third cut at `"gpu_power":2` (of 25.04) with no newline, as when a chunk boundary or the idle-stop kill splits a line. The fragment must be buffered or discarded, never parsed. |

**Provenance**
- Synthesized from `vladkens/macmon@v0.8.2` (`6919d7781b6c55a6e3bedff83a210435837e1dfe`):
  - `src_app/main.rs:18-37`: `JsonMetrics` flattens `Metrics` and adds the v0.7 aliases;
  - `src_app/main.rs:198-221`: the pipe loop runs `to_value`, adds `timestamp` (`to_rfc3339`) and calls `println!`;
  - `src_lib/metrics.rs:24-144`: the field set;
  - `src_lib/metrics.rs:185`: `all_power = cpu + gpu + ane`;
  - `src_lib/metrics.rs:473-475` and `:561-564`: `sys_power = max(PSTR, all_power)`, or `0.0` when `PSTR` can't be read;
  - `Cargo.lock:1425-1435`: `serde_json` without `preserve_order`, so keys are sorted at every level.
- Legacy: `vladkens/macmon@v0.7.2` (`20665fdee05414518792be981b202b713cf3b196`), `src/metrics.rs:31-44`,
  `src/metrics.rs:323-326` and `src/main.rs:68-73`.
- `f32` values print as the shortest string that round-trips, with `.0` on whole numbers. `all_power` is the `f32` sum, so
  `3.412 + 24.87 + 0.0` prints as `28.282001`.
- The label is "Chip power (CPU+GPU+ANE, macmon estimate) · includes all apps · not wall power" (SPIKES S9). Scope never
  installs macmon.

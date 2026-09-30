# Prometheus text 0.0.4 fuzz corpus

Synthetic seed inputs for `service/lib/prometheus.ts` (plan §5.3: "fuzz corpus included"). Nothing here was captured from
a runtime. Every metric name starts with `fx_`, so no file can be mistaken for a real scrape.

`service/lib/prometheus.test.ts` asserts the exact parse of each seed, then mutates every seed (and every llama-server and
Splash `/metrics` fixture) with a seeded generator: byte flips, deletions, duplications, line shuffles, CRLF endings and
truncation. The parser must never throw, must keep only allowlisted names, must hold its 2 MB and 5,000-sample bounds, and
must stay linear on pathological input (one 2 MB line, 100k tiny lines, deep label lists).

| File | Covers |
|---|---|
| `escapes.txt` | `\"`, `\\`, `\n` label escapes; an unknown escape kept literally; commas, braces and `=` inside values; spaces around labels; a trailing comma; a blank before `{`; empty `{}`. |
| `values.txt` | `NaN`, `+Inf`, `-Inf`, `Inf`, exponent form (`3.21457e+06`, as llama-server prints counters ≥ 1e6), `-0`, `.5`, `5.`, timestamps (also negative); rejected: hex, empty, words, a non-numeric timestamp, three tokens. |
| `histogram.txt` | Shuffled buckets, two label sets, a non-cumulative histogram, one without `+Inf`, and a summary. |
| `malformed.txt` | Lines a lenient parser must skip without losing the valid ones around them; broken `# TYPE` lines; a duplicate `TYPE` (the first wins). |
| `whitespace.txt` | Tabs, leading and trailing blanks, a blank line. |
| `unicode.txt` | Multi-byte UTF-8 label values (the byte bound is UTF-8, not UTF-16). |
| `no-trailing-newline.txt` | A last line without `\n`. |

The local `.editorconfig` keeps editors from trimming the trailing blanks or adding a final newline, both of which are
cases here.

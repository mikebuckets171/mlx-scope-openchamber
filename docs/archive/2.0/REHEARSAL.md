# Isolated OpenChamber instance for the Stage 12 git-update rehearsal (MLX Scope 2.0, §8.10 / S11)

This was read-only research. Nothing was installed, launched, changed or quit. I read nothing inside `~/.config/openchamber`; I only checked whether a few named entries exist.

## Recommendation (closes S11 "still open")

Run a second **web runtime** using the code already in the installed app, and point it at a scratch data directory:

- **Same code as the desktop.** The OpenChamber 2.0.4 server code comes from `OpenChamber.app/Contents/Resources/app.asar`. It runs under the app's own Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`) and in `--foreground`. Extension services are therefore started by the same executable the desktop uses.
- **Its own data.** `OPENCHAMBER_DATA_DIR` points at a scratch folder, and `OPENCHAMBER_MANAGED_PROCESS_REGISTRY` points at another. The second one matters because the registry ignores the data-dir variable.
- **Its own OpenCode.** You start a separate OpenCode server from the app's bundled `opencode`, with its own `XDG_*` folders. OpenChamber attaches to it through `OPENCODE_SKIP_START=true` + `OPENCODE_HOST`. This mode never opens your real OpenCode database for writing.
- **Its own browser profile.** A throwaway Chrome profile keeps cookies and storage separate.

The desktop app can run a second profile, but it shares more machine-wide state. npm and a second macOS user are worse fits. Details are under Alternatives.

## Direct answers

- **How to point it at another data dir:** set `OPENCHAMBER_DATA_DIR`. The 2.0.4 CLI has no `--data-dir` flag.
  - `XDG_CONFIG_HOME` does not move `~/.config/openchamber`; that path is built from the home directory.
  - Overriding `HOME` would move it, but it breaks two things:
    - the manifest's `~/…` exec paths (they resolve against the server's home);
    - the MLX Scope service's credential lookup (it gets `HOME`).
- **What still uses `~/.config/openchamber` even with `OPENCHAMBER_DATA_DIR` set** (2.0.4 code):
  - `managed-opencode/`: override with `OPENCHAMBER_MANAGED_PROCESS_REGISTRY`.
  - `install-id-<appType>`: written only if missing. `install-id-web` already exists, so this is a read.
  - `git-identities.json`: absent today. It is created only if you save a Git identity.
  - `tmp/oc-integrate-*`: only the Git "integrate" feature uses it.
  - On first start, `projects/`, `themes/` and `speech-models/` are copied **from** the real folder unless those folders already exist in the new data dir.
- **Running both at once:** supported.
  - The CLI refuses a port the desktop is using.
  - Managed OpenCode ports are picked by the OS (port 0).
  - Extension services get random loopback ports.
  - The relay lock and identity are per data dir, and passive relay hosting needs a paired device. `OPENCHAMBER_RELAY_HOST=off` disables it outright.
  - The Electron single-instance lock is taken only by the desktop entry point (`entry.mjs`), and it follows the userData folder.
- **Logging in:** set `OPENCHAMBER_UI_PASSWORD` and the browser shows a password login.
  - The session cookie name includes the port (`oc_ui_session_<port>`), so it cannot clash with another instance.
  - Loopback without a password also works, with a warning.
- **Shutting it down:** Ctrl-C the foreground server. It stops the extension services, the server and its process files. Then Ctrl-C the OpenCode server, close the throwaway Chrome, check that nothing is left, and delete the scratch folder.

## Procedure

Use a login Terminal. The scratch folder sits outside every repo, so the scrub gate never sees it. Paste this block into each terminal:

```sh
export OC_APP=/Applications/OpenChamber.app
export OC_BIN="$OC_APP/Contents/MacOS/OpenChamber"
export OC_ASAR="$OC_APP/Contents/Resources/app.asar"
export OC_CLI_JS="$OC_ASAR/node_modules/@openchamber/web/bin/cli.js"
export OC_OPENCODE="$OC_APP/Contents/Resources/opencode-cli/opencode"
export ISO="$HOME/CodexWork/oc-rehearsal-2.0"
export REAL="$HOME/.config/openchamber"
export REPO="$HOME/CodexWork/mlx-scope-2"
```

**0. Owner gates (ask before starting)**
- Running a second instance.
- Creating the public branch `rc/2.0.0` (step 5).
- Pushing the RC to it (step 8).
- Installing into the isolated instance (G3-style).

During the rehearsal, don't touch Settings → Extensions in the real app. Don't run any §8.5 overhead or soak measurements at the same time.

**1. Preflight (read-only)**
```sh
defaults read "$OC_APP/Contents/Info.plist" CFBundleShortVersionString        # 2.0.4
test ! -e "/Library/Application Support/OpenChamber/policy.json" && echo "no enterprise policy"
lsof -nP -iTCP:3917 -sTCP:LISTEN; lsof -nP -iTCP:4917 -sTCP:LISTEN            # both empty
env | grep -E '^(OPENCHAMBER|OPENCODE|XDG)_' | cut -d= -f1                    # empty
ELECTRON_RUN_AS_NODE=1 "$OC_BIN" "$OC_CLI_JS" --version                        # 2.0.4
```
- **Proves:** the host version and that no enterprise policy applies. The last line proves Node mode can run the CLI from inside the asar; it prints and exits without starting anything.
- **If the last line prints nothing or errors,** use this fallback, which needs no network:
  ```sh
  mkdir -p "$ISO/app"
  node /private/tmp/claude-501/oc-research/asar.mjs "$OC_ASAR" extract "$ISO/app"
  cp -R "$OC_ASAR.unpacked/." "$ISO/app/"
  export OC_CLI_JS="$ISO/app/node_modules/@openchamber/web/bin/cli.js"
  ```
  `/private/tmp` can be cleared on reboot. If the script is gone, `npx @electron/asar extract` does the same but downloads a package, so it needs your approval.

**2. Scratch folders and a baseline of the real install (file metadata only, never contents)**
```sh
umask 077
mkdir -p "$ISO"/{data/projects,data/themes,data/speech-models,managed-opencode,xdg/config,xdg/data,xdg/state,xdg/cache,work,receipts,chrome}
openssl rand -hex 24 > "$ISO/.oc-pw"; openssl rand -base64 18 > "$ISO/.ui-pw"
touch "$ISO/receipts/t0"
(cd "$REAL" && find . -maxdepth 1 | sort) > "$ISO/receipts/real-top-before.txt"
stat -f '%i %m %z %N' "$REAL/extensions.json" "$REAL/extensions" > "$ISO/receipts/real-ext-before.txt"
ls -1 "$REAL/extensions" > "$ISO/receipts/real-extdirs-before.txt"
ls -1 "$REAL/managed-opencode" > "$ISO/receipts/real-managed-before.txt"
pgrep -x OpenChamber > "$ISO/receipts/desktop-pid-before.txt"
```
- **Proves:** a baseline of the real install to compare against later.
- The pre-made `projects`, `themes` and `speech-models` folders stop the one-time copy from the real folder. That copy could be gigabytes of speech models.
- Nothing here reads a file's contents, including `settings.json`.

**3. Terminal A: the isolated OpenCode server**
```sh
cd "$ISO/work" && env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" PATH="$PATH" \
  LANG="${LANG:-en_US.UTF-8}" TMPDIR="$TMPDIR" TERM="$TERM" \
  XDG_CONFIG_HOME="$ISO/xdg/config" XDG_DATA_HOME="$ISO/xdg/data" XDG_STATE_HOME="$ISO/xdg/state" XDG_CACHE_HOME="$ISO/xdg/cache" \
  OPENCODE_DISABLE_AUTOUPDATE=1 OPENCODE_PASSWORD="$(cat "$ISO/.oc-pw")" \
  "$OC_OPENCODE" serve --hostname 127.0.0.1 --port 4917
```
- **Proves:** the same OpenCode 2.0.18 binary the desktop uses is running, with its database, config and cache only under `$ISO/xdg`.
- **Check:** `ls "$ISO/xdg/data/opencode"` shows its own `opencode.db`.
- **Why a separate server:** your real OpenCode database is never opened for writing, and no `opencode serve` is added to the shared registry.

**4. Terminal B: isolated OpenChamber (no `XDG_*` in this environment)**
```sh
cd "$ISO/work" && env -i HOME="$HOME" USER="$USER" LOGNAME="$LOGNAME" SHELL="$SHELL" PATH="$PATH" \
  LANG="${LANG:-en_US.UTF-8}" TMPDIR="$TMPDIR" TERM="$TERM" \
  ELECTRON_RUN_AS_NODE=1 \
  OPENCHAMBER_DATA_DIR="$ISO/data" OPENCHAMBER_MANAGED_PROCESS_REGISTRY="$ISO/managed-opencode" \
  OPENCHAMBER_DIST_DIR="$OC_APP/Contents/Resources/web-dist" \
  OPENCHAMBER_RELAY_HOST=off OPENCHAMBER_PUSH_RELAY_DISABLED=true \
  OPENCODE_BINARY="$OC_OPENCODE" OPENCODE_SKIP_START=true OPENCODE_HOST="http://127.0.0.1:4917" \
  OPENCODE_PASSWORD="$(cat "$ISO/.oc-pw")" OPENCHAMBER_UI_PASSWORD="$(cat "$ISO/.ui-pw")" \
  "$OC_BIN" "$OC_CLI_JS" serve --foreground --quiet --port 3917 --host 127.0.0.1
```
Optional: add `OPENCHAMBER_UPDATE_API_URL=http://127.0.0.1:9/` so this instance sends no update-check telemetry.

The server log goes to `$ISO/data/logs/openchamber-3917.log`. Check it:
```sh
grep -c "skip-start mode" "$ISO/data/logs/openchamber-3917.log"     # 1
grep -E "\[data-dir\] Copied|Starting OpenCode on|V1 session migration|reaped" "$ISO/data/logs/openchamber-3917.log"   # nothing
```
- **Proves:**
  - it runs the exact 2.0.4 server code;
  - it attached to the isolated OpenCode;
  - nothing was copied from the real folder;
  - it never touched the real OpenCode database or the real registry.
- **Why no `XDG_*` here:** extension services inherit `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME`, and MLX Scope's `config.ts` follows them. If they were set, Scope would look in the isolated OpenCode config and find no runtimes.

**5. [OWNER GATE] Create `rc/2.0.0` at v1.6.1**
```sh
cd "$REPO" && git push origin "$(git rev-parse 'v1.6.1^{commit}'):refs/heads/rc/2.0.0"
git ls-remote origin refs/heads/rc/2.0.0        # must print the 290a39e… commit
```
- **Risk:** the repo is public, so anyone can see and pin this branch. It is not a GitHub release.

**6. Open the isolated UI and install**
```sh
open -na "Google Chrome" --args --user-data-dir="$ISO/chrome" --no-first-run --no-default-browser-check "http://127.0.0.1:3917/"
pbcopy < "$ISO/.ui-pw"      # paste at the login, then: pbcopy </dev/null
```
1. Settings → Extensions should list **no** user extensions. That proves this instance has its own catalog.
2. In "Folder, ZIP, or URL", enter `https://github.com/mikebuckets171/mlx-scope-openchamber.git#rc/2.0.0` and click **Add**.
3. The "Allow MLX Scope?" dialog should say "Runs: /usr/bin/vm_stat, /usr/sbin/sysctl, lms". Click **Allow and enable**.

Check on disk:
```sh
jq '{gitOrigins, capabilityGrants}' "$ISO/data/extensions.json"      # ref "rc/2.0.0"
jq -r .version "$ISO/data/extensions/mlx-scope/package.json"          # 1.6.1
git -C "$ISO/data/extensions/mlx-scope" rev-parse HEAD                 # the v1.6.1 commit
```

**7. Save data on 1.6.1 (with oMLX or Bionic running)**
1. Open MLX Scope and save a capture.
2. Count the stored key types, names only:
   ```sh
   jq -r 'keys[]' "$ISO/data/guest-storage/mlx-scope.json" | sed -E 's/\.[^.]*$//' | sort | uniq -c
   ```
3. Click **Check for updates**. Expect "Everything is up to date."

- **Proves:** `observation.v1.*` keys exist to migrate, and the pinned-ref fetch works before the RC exists.

**8. [OWNER GATE] Push the RC to `rc/2.0.0`**
```sh
RC=<rc sha>; git merge-base --is-ancestor v1.6.1 "$RC" && echo ff-ok
git show "$RC:package.json" | jq '{version, id: .openchamber.contributes.panel.id, engines: .openchamber.engines}'
git push origin "$RC:refs/heads/rc/2.0.0"
```
The RC must have:
- a version above 1.6.1, for example `2.0.0-rc.1`;
- panel id **`mlx-scope`** (a different id fails the update as `invalid-manifest`);
- the built bundles committed;
- `engines.openchamber` of `>=2.0.4`.

The push is a fast-forward, so no force is needed.

**9. Trigger and check the update**
1. Click **Check for updates**. The automatic check when the page opens is cached for up to an hour; this button forces a fresh one.
2. Expect "Update available · v2.0.0-rc.1", then click **Update**.
3. Expect the following:
   - the service stops before the files are swapped;
   - the row shows **Needs approval**;
   - frames that are open get `NO_SERVICE`, which 2.0 shows as its needs-approval state;
   - the review dialog lists exactly the §6 exec set;
   - after approval, the frames reload.
4. Check on disk:
   ```sh
   jq -r .version "$ISO/data/extensions/mlx-scope/package.json"
   jq -r 'keys[]' "$ISO/data/guest-storage/mlx-scope.json" | sed -E 's/\.[^.]*$//' | sort | uniq -c   # v1 kept + capture.v2 added
   ls -a "$ISO/data/extensions"                                                                       # no .tmp-*/.old-*
   for f in panel/main.js service/main.js background/main.js; do git -C "$REPO" show "<beta-sha>:$f" | cmp - "$ISO/data/extensions/mlx-scope/$f" && echo "$f identical"; done
   ```
- **Expect the needs-approval state, not the version-skew message.** A git update stops the old service first, so a 1.6 service can't answer the 2.0 panel. `contract_mismatch` probably won't appear on this path. Record whichever state you actually see.

**10. Tear down**
1. Ctrl-C terminal B, then terminal A. Close the throwaway Chrome.
2. Check nothing is left:
   ```sh
   lsof -nP -iTCP:3917 -sTCP:LISTEN; lsof -nP -iTCP:4917 -sTCP:LISTEN       # empty
   pgrep -fl "$ISO" || echo "no isolated processes"; ls "$ISO/data/run"      # empty
   ```
3. Write the receipt with shapes, counts and booleans only (no paths).
4. With your yes, run `rm -rf "$ISO"`.
5. Later, as an owner gate, delete the branch: `git push origin --delete rc/2.0.0`.

## Checking the real install was untouched (run after teardown)

```sh
(cd "$REAL" && find . -maxdepth 1 | sort) | diff "$ISO/receipts/real-top-before.txt" - && echo "no new top-level entries"
stat -f '%i %m %z %N' "$REAL/extensions.json" "$REAL/extensions" | diff "$ISO/receipts/real-ext-before.txt" - && echo "real catalog untouched"
ls -1 "$REAL/extensions" | diff "$ISO/receipts/real-extdirs-before.txt" -
ls -1 "$REAL/managed-opencode" | diff "$ISO/receipts/real-managed-before.txt" -
test ! -e "$REAL/git-identities.json" && echo "no identity store created"
ls -d "$REAL"/tmp/oc-integrate-* 2>/dev/null | wc -l                       # 0
find "$REAL" -newer "$ISO/receipts/t0" -type f | sed "s#^$REAL/##" | sort   # only files the desktop itself wrote
pgrep -x OpenChamber | diff "$ISO/receipts/desktop-pid-before.txt" - && echo "desktop process unchanged"
ls "$ISO/managed-opencode" | wc -l                                          # 0 (no managed OpenCode was started)
```
In the real app, Settings → Extensions should show the same list and versions as before, and no `rc/2.0.0` origin. The real install's update check follows its own branch (`origin <ref|HEAD>`), so pushing `rc/2.0.0` never reaches it.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Writes into the real `managed-opencode/` from the registry and its cleanup | `OPENCHAMBER_MANAGED_PROCESS_REGISTRY`, plus using a separate OpenCode server |
| On a managed start, OpenChamber opens the real OpenCode database for writing and may update one migration record | Separate OpenCode (`OPENCODE_SKIP_START` + `OPENCODE_HOST`) |
| The real `projects/`, `themes/` and `speech-models/` get copied in | Create the empty folders before first start |
| `XDG_*` inherited by the MLX Scope service | Set `XDG_*` only on the OpenCode process |
| Telemetry sends the existing `install-id-web` | Turn off usage reports in the isolated Settings, or set `OPENCHAMBER_UPDATE_API_URL` to a closed port |
| Clicking OpenChamber's own **Update** in the isolated About page would run a global package install | Never click it |
| Actions that write shared state (OpenCode config, skills, Git identities, the integrate feature, adding real project folders) | Only use Extensions and the MLX Scope surfaces |
| Real and isolated MLX Scope services both probe the runtimes | Keep the rehearsal short; no overhead runs meanwhile |
| The public `rc/2.0.0` branch | Owner gate; delete it after G6 |
| Passwords sit in `$ISO` files and in the process environment (visible to the same user with `ps -E`); the process file also stores the UI password | Files are mode 600; the process file is removed on exit; the scratch folder is deleted at teardown |
| `env -i` drops proxy variables | Add `https_proxy` back only if you use a proxy |

## Alternatives considered
- **Desktop app with a second profile:** possible. Run the app binary directly with `OPENCHAMBER_DATA_DIR` and `OPENCHAMBER_DESKTOP_USER_DATA_DIR`. It shares more machine-wide state:
  - it rewrites login-item settings at startup (keeping the current value);
  - it shares the one app bundle and its updater;
  - it adds a second menu-bar icon;
  - it would still use the real registry, and its managed start would open the real OpenCode database.

  Not recommended.
- **`npx` / `npm i @openchamber/web@2.0.4`:** it is published, but it needs an install. The CLI's background mode prefers Bun when installed, so extension services would run under Bun or Node, not Electron.
- **A second macOS user:** full isolation, but the runtime configs and credentials live in your home folder, so the saved capture wouldn't match your real setup.

## VERIFIED
Confirmed by reading the 2.0.4 app bundle, binaries, the npm and GitHub registries, and the repo. Paths are relative to the extracted `…/node_modules/@openchamber/web/`.

1. **Versions and contents:** app 2.0.4 contains `@openchamber/web` 2.0.4 (CLI and server) and OpenCode 2.0.18. The file list in `Resources/web-dist` matches the asar's `dist`.
2. **Data dir:** `OPENCHAMBER_DATA_DIR` is honoured by `bin/lib/cli-paths.js:10-15`, `server/index.js:296-350`, the extension store, storage, auth, logs and `run/`, and the desktop's `early-startup` settings path.
3. **Paths that stay under the real folder:**
   - `server/lib/opencode/managed-process-registry.js:56-60`
   - `server/lib/package-manager.js:25-55`
   - `server/lib/git/identity-storage.js:5`
   - `server/lib/git/service.js:1423`
   - the copy step in `server/lib/data-dir-migration.js`
4. **OpenCode's own data:**
   - `server/lib/opencode/auth.js:25` reads `~/.local/share/opencode` directly.
   - `v1-migration-topup.js:232-280` can run `UPDATE kv`, and only on the managed start path (`lifecycle.js:715-760`).
   - Skip-start needs a port or host; without one, OpenCode starts anyway (`lifecycle.js:1128`).
   - `OPENCODE_HOST` sets the port that is used (`env-config.js`).
   - `OPENCODE_DATA_DIR` doesn't appear in either binary, so it does nothing in 2.0.4.
5. **Bundled OpenCode:** it follows the `XDG_*` variables, and it recognises `OPENCODE_DISABLE_AUTOUPDATE` and `OPENCODE_PASSWORD`.
6. **Extension services:** they are started as the host executable with `ELECTRON_RUN_AS_NODE=1`, and their environment allowlist includes `XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `XDG_CACHE_HOME` (`guests/service.js:420-436, 498-503`). The RunAsNode fuse is enabled.
7. **CLI `serve`:**
   - flags `--port`, `--host`, `--ui-password`, `--foreground` and `--quiet`;
   - refuses the desktop's port;
   - in foreground it runs in-process and cleans up its process files;
   - `--quiet` sends server output to `logs/openchamber-<port>.log`;
   - background mode prefers Bun (`bin/cli.js:154`).
8. **Relay:** off with `OPENCHAMBER_RELAY_HOST=off`, and its lock is per data dir (`index.js:2185-2198`). The login cookie is scoped by port (ui-auth documentation).
9. **Extensions:**
   - `#rc/2.0.0` is a valid ref;
   - installs clone with `--depth 1 --branch <ref>` into `<data>/extensions/<id>`;
   - the update check fetches the ref and compares semver, with prereleases ranked below releases;
   - results are cached for an hour and **Check for updates** forces a new one;
   - an update requires the same panel id, stops the service, then swaps the files;
   - a larger exec list puts the extension into Needs approval;
   - only public Git hosts are allowed (`guests/clone.js`, `guests/updates.js`, `guests/DOCUMENTATION.md`).
10. **Repo:** it is public, and `rc/2.0.0` and `legacy/1.6.x` are not on the remote yet. `v1.6.1` (`290a39e`) is an ancestor of `next/2.0`. Its manifest has id `mlx-scope`, exec `vm_stat`, `sysctl` and `lms`, and committed bundles.
11. **This Mac today:**
    - there is no enterprise policy file;
    - ports 3917 and 4917 are free;
    - the desktop is running on random loopback ports;
    - no `OPENCHAMBER_`, `OPENCODE_` or `XDG_` variables are set;
    - `install-id-web` exists and `git-identities.json` does not.

## INFERENCE (to be confirmed at step 1 or during the run)
1. Node mode can load the CLI's modules and serve assets from inside the asar. Step 1's `--version` check proves this, and the extract fallback covers a failure.
2. Node mode creates no Electron app, lock, Dock icon or menu-bar icon.
3. The UI reaches Settings → Extensions and the rail without a project or a model provider. If a chat is needed, create one; it lives under `$ISO/data/chats`.
4. The separate OpenCode server accepts the Basic authentication that OpenChamber sends.
5. The version-skew message probably can't be reached on the git path.
6. Chrome renders the extension frames the same way the Electron window does, apart from desktop-only features.
7. The duplicate MLX Scope services only add probe load.

The research helper files are in `/private/tmp/claude-501/oc-research/`:
- `asar.mjs`: a read-only asar reader that needs no network;
- `x/`: the extracted bundle;
- `upstream-README.md` and `doc-*.mdx`: upstream docs.

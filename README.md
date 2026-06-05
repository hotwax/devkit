# devkit

A lightweight, **local-only** dev cockpit for [Moqui](https://www.moqui.org/) / Maarg. It gives a
cold-start dev one screen that answers "what's running, how is it wired, and is my setup right?" —
and lets you start/stop the pieces. Zero dependencies, no build step, runs from anywhere.

```bash
npx github:hotwax/devkit
# then open http://127.0.0.1:7070
```

After the workspace exists, Devkit can write `~/Documents/github/Open HotWax DevKit.command`; double-click it to restart Devkit and open the dashboard.

> Requires **Node 18+**. macOS-first (uses `lsof`, `screen`, Homebrew paths by default).

## Cold-start NotNaked flow

Open the dashboard and use **Get started → Continue setup**. Devkit chooses the next safe action: it
prepares the local stack when possible, or writes the private bundle request when NotNaked repos are
still missing. The explicit **Prepare local stack** button runs the same service/bootstrap flow on
request. Devkit will:

- bootstrap the HotWax/Moqui workspace under `~/Documents/github`;
- use GitHub archives when Git/Apple Command Line Tools are not installed yet;
- upgrade archives to real clones later after `xcode-select --install`;
- start bundled MySQL, bundled Solr, and the configured AccxUI PWAs;
- start Moqui only when the real NotNaked repositories/components are present.

For private repositories, use **Resolve with GitHub token**. Devkit diagnoses the token, discovers
candidate repos, checks current target access, and prepares the local stack when the target is
reachable. On a Mac without Git/Apple CLT, the same token is used to fetch private repositories as
GitHub archives; after CLT is installed, **Upgrade archives with token** replaces them with real
clones. The token is passed only to that one request and is not saved.
Bootstrap uses the branch in the NotNaked target first, then falls back to the repository's GitHub
default branch and the usual `main` / `master` guesses.
Use **Setup → NotNaked repo access → Diagnose token** when a token still cannot fetch private repos;
Devkit checks authentication, API rate limits, HotWax org visibility, current target repos, and
whether the private repo zipballs are fetchable for no-Git cold starts.

For real clones on a fresh Mac, use **Get started → Install Apple CLT**. Devkit requests the macOS
Command Line Tools installer and watches for Git to become available. After the installer finishes,
use **Upgrade archives with token** to replace temporary archive folders with git clones.
Use **Setup → Source checkouts → Check CLT status** to see whether CLT is active and whether
`softwareupdate` currently exposes a Command Line Tools package.

If the private NotNaked repository names differ from the packaged guess, open **Setup → NotNaked repo
access → Discover with token** to search the HotWax org with a one-time token. Devkit shows candidate
repos and, when it finds strong matches, can open a proposed target for review. Save the reviewed
target override at `~/Documents/github/notnaked-target.local.json`; Devkit refreshes repo access and
readiness after saving. Use **Write target override template** only when you want to create the file
first. The local override is machine-specific and replaces only the fields present in that file.
If a private repo already exists somewhere else on disk, use **Import local path** to symlink it into
the expected workspace path and relink any now-available Moqui components. If you have a folder full
of repo checkouts, use **Import local folder** to scan for every NotNaked target repo in one pass.
That folder may also contain repo archives such as `poorti.zip`, `hotwax-poorti.tar.gz`, or
`hotwax/poorti.zip`; Devkit extracts matching archives only when the target folder is still missing.
Use **Write bundle request** to create `~/Documents/github/notnaked-private-bundle-request.md` and
`~/Documents/github/pack-notnaked-private-bundle.sh` for someone who has access to package the
missing private repos.
Once the bundle is on this machine, **Import folder + prepare** imports it, relinks components,
starts MySQL/Solr/PWAs, and starts Moqui only if the real NotNaked repo/component gates pass.

Terminal gates:

```bash
hotwax-bootstrap
hotwax-check-notnaked
hotwax-check-readiness
hotwax-unblock-report
hotwax-devkit-control restart
```

`hotwax-check-readiness` exits nonzero until the full NotNaked target is actually ready. The unblock
report is meant to paste to whoever controls repo access or canonical component names.
`hotwax-devkit-control restart` cleanly replaces the dashboard process on port 7070, including the
macOS/screen case where the screen session disappears but the Node listener remains.
The dashboard can also write `~/Documents/github/hotwax-devkit-state.json`, a machine-readable
snapshot of the objective audit, readiness gates, source state, toolchains, CLT status, and next
actions. When private repos are still missing, the snapshot includes `privateRepoBundleRequest` with
acceptable folder/archive names for the one-pass **Import local folder** flow.

## What you get

A dashboard at `http://127.0.0.1:7070` with three main views:

- **Get started** — one-click prepare flow, NotNaked readiness gate, and exact remaining blockers.
- **System architecture** — a live, color-coded map from the **Java 11 JVM → MySQL / Solr → Moqui →
  REST API → PWA apps**. Click any box for detail; running web nodes have an `↗` open link; click
  **Start / Stop / Restart** to control Moqui, MySQL, or a PWA dev server.
- **Setup** — remembered Moqui/AccxUI folders, running PWA detection, source checkout state
  (`clone` / `archive` / `missing`), bundled toolchain checks, and NotNaked repo access status.
- **Running AccxUI apps** — detects localhost Vite/PWA servers, maps them back to app names and
  serving folders, checks that each configured app shell loads, and shows direct links so you do not
  have to remember which app owns which URL. Use **Write config + restart PWAs** to create `.env.local`
  files pointing the PWAs at local Moqui (`http://localhost:8080` / `/rest/s1/`) and restart the
  dev servers so those values are loaded.
- **Details** —
  - **Preflight**: Java 11, ports (8080 / 3306 / 8983 / 9200), MySQL & Solr reachability, Moqui liveness.
  - **Effective config**: parsed from `runtime/log/MoquiActualConf.xml` (DB, search backends; secrets redacted).
  - **Components**: each `runtime/component/*` with its git **branch** (flags off-`main`) and
    **uncommitted-changes** state (modified / untracked).
  - **Expected components**: compares what you have against the `oms-suite` / `all` sets in
    `maarg-docker-config`'s `myaddons.xml`, and gives the exact `./gradlew getComponent` command for anything missing.
  - **Logs**: a byte-offset tail of the Moqui log (never full-reads it).
  - **Diagnose**: turns the observed signals into concrete next-actions (the Java-11-not-on-PATH trap,
    a port held by an orphaned GradleDaemon, MySQL down, missing components, …).

It's **read-mostly**: the only writes are the guarded Start / Stop / Restart actions, bound to
`127.0.0.1`. Stops scope-kill by PID (shown after the action) — never a blanket `pkill`.

## How it finds Moqui

`MOQUI_HOME` is auto-discovered, in order:

1. the **running** `java … -jar moqui.war` process (works no matter where you run devkit from);
2. `$MOQUI_HOME` / `devkit.config.json` (see below);
3. **walking up** from your current directory (so it self-locates when run from inside a checkout);
4. a configured run script's `cd` target.

So a Moqui-only dev can `cd` into their `moqui-framework` checkout and `npx github:hotwax/devkit`.

## Moqui-only vs. PWA workspace

If your current directory is an accxui-style PWA workspace (has `pnpm-workspace.yaml` or `apps/`),
devkit also discovers and manages the PWA dev servers. Otherwise it runs in **Moqui-only mode**: the
full Moqui stack is managed, and the PWA band is simply marked "not in this workspace."

## Configuration

Everything has sensible defaults. Override per-project with a `devkit.config.json` in the directory
you run devkit from:

```json
{
  "moquiRunScript": "/path/to/run-moqui-local.sh",
  "screens": { "moqui": "my-moqui", "solr": "my-solr" },
  "pwaApps": [{ "name": "order-manager", "port": 8106, "dir": "apps/order-manager" }]
}
```

The cold-start bootstrap also writes `~/Documents/github/devkit.config.json`. Devkit reads that
workspace-level config from any launch directory before applying a project-local config, so the
dashboard still finds bundled Java 11, Moqui, and AccxUI when started from the Devkit checkout or an
`npx` cache path. Explicit env vars always win.

…or with env vars (no file needed):

| var | purpose |
|---|---|
| `MOQUI_HOME` | explicit Moqui checkout path |
| `MOQUI_RUN_SCRIPT` | a script that `cd`s into the checkout and runs `./gradlew run` |
| `JAVA11_HOME` | Java 11 home (default: `/opt/homebrew/opt/openjdk@11`) |
| `MOQUI_CONSOLE_PORT` | console port (default `7070`) |
| `MOQUI_CONSOLE_NO_PWA=1` | force Moqui-only mode |

## License

Apache-2.0

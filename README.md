# devkit

A lightweight, **local-only** dev cockpit for [Moqui](https://www.moqui.org/) / Maarg. It gives a
cold-start dev one screen that answers "what's running, how is it wired, and is my setup right?" —
and lets you start/stop the pieces. Zero dependencies, no build step, runs from anywhere.

```bash
npx github:hotwax/devkit
# then open http://127.0.0.1:7070
```

> Requires **Node 18+**. macOS-first (uses `lsof`, `screen`, Homebrew paths by default).

## What you get

A dashboard at `http://127.0.0.1:7070` with two tabs:

- **System architecture** — a live, color-coded map from the **Java 21 JVM → MySQL / Solr → Moqui →
  REST API → PWA apps**. Click any box for detail; running web nodes have an `↗` open link; click
  **Start / Stop / Restart** to control Moqui, MySQL, or a PWA dev server.
- **Running AccxUI apps** — detects localhost Vite/PWA servers, maps them back to app names and
  serving folders, and shows direct links so you do not have to remember which app owns which URL.
- **Details** —
  - **Preflight**: Java 21, ports (8080 / 3306 / 8983 / 9200), MySQL & Solr reachability, Moqui liveness.
  - **Effective config**: parsed from `runtime/log/MoquiActualConf.xml` (DB, search backends; secrets redacted).
  - **Components**: each `runtime/component/*` with its git **branch** (flags off-`main`) and
    **uncommitted-changes** state (modified / untracked).
  - **Expected components**: compares what you have against the `oms-suite` / `all` sets in
    `maarg-docker-config`'s `myaddons.xml`, and gives the exact `./gradlew getComponent` command for anything missing.
  - **Logs**: a byte-offset tail of the Moqui log (never full-reads it).
  - **Diagnose**: turns the observed signals into concrete next-actions (the Java-11-not-on-PATH trap,
    a port held by an orphaned GradleDaemon, MySQL down, missing components, …).

It's **read-mostly**: the writes are the guarded Start / Stop / Restart actions and the **Database**
tab below, all bound to `127.0.0.1`. Stops scope-kill by PID (shown after the action) — never a
blanket `pkill`.

## Clean standard Maarg setup

The **Get started** tab can now bootstrap a complete standard local OMS suite without copying a
sequence of terminal commands. Choose a dedicated workspace folder, then select **Wipe + bootstrap**
and type that exact folder path to confirm. DevKit owns the full sequence:

- deletes the selected workspace and recreates it;
- clones current `main` framework, runtime, and `maarg-docker-config` sources;
- installs the `oms-suite` component set and MySQL JDBC driver;
- configures a local MySQL `moqui` database/user, runs `omsSetup -PmaargOnly=true`, clears
  temporary Moqui launch files, and loads the standard seed/install/extension data in isolated
  Gradle invocations;
- installs and starts Solr, then starts Moqui and waits for its login-options endpoint to return 200.

This uses JDK 21, which the current Moqui framework requires. The bootstrap is intentionally
destructive and only accepts a dedicated workspace folder; it rejects `/`, your home folder, and the
DevKit checkout itself. If any step fails, the job keeps its command log in the selected workspace so
the failure is visible in DevKit rather than becoming a hidden partial setup.

## Database — reset to seed · snapshot · revert

The **Database** tab lets you iterate without fear of corrupting data:

- **Reset to base seed** — stops Moqui, drops & recreates the MySQL database, re-runs the team's
  canonical load (read straight from `maarg-docker-config`'s `DB_LOAD`, e.g.
  `./gradlew loadProduction -Ptypes=seed,seed-initial,install,ext-seed,ext -Praw`; falls back to
  `./gradlew load`), clears the search index (ES/OpenSearch + Solr), then restarts.
- **Snapshot** — a `mysqldump --single-transaction | gzip` checkpoint, saved as a plain `.sql.gz` in
  `<MOQUI_HOME>/runtime/db-snapshots/` (auto-gitignored). Non-destructive; works while Moqui is up.
- **Revert** — integrity-checks the snapshot, then stops Moqui, recreates the DB, restores the dump,
  clears search, and restarts.

If you run **more than one Moqui at once** (e.g. `:8080` and `:8081`), an **Environment** picker
appears at the top of the tab listing each detected instance (port · home · database) so you choose
which one devkit targets — and every action (reset, snapshot, revert, start/stop/restart, the live
dot) then acts on *that* instance's port, home, and database. This is also a safety property: with two
instances up, a reset stops the right JVM instead of guessing the first.

It's deliberately **fail-closed**. devkit reads the datasource identity from the merged, comment-free
`runtime/log/MoquiActualConf.xml` (never a regex over the hand-edited `MoquiDevConf.xml`), and
**refuses** to act unless the datasource is local MySQL on `localhost`. Destructive actions require you
to type the database name to confirm (re-checked server-side), the long load streams to a live log,
and credentials are resolved server-side and **never** sent to the browser. Search is *cleared*; the
*rebuild* is Moqui's restart — ES DataFeeds with `indexOnStartEmpty="Y"` (e.g. `OmsProduct`)
auto-reindex on boot; Solr is cleared and left for your reindex.

> devkit doesn't store credentials. It resolves the DB password from (in order) `devkit.config.json`,
> `entity_ds_password`/`MYSQL_PWD` env, a comment-stripped `MoquiDevConf.xml`/`MoquiProductionConf.xml`,
> or your run script — and otherwise relies on passwordless local auth. If it can't connect, set `db`
> in `devkit.config.json` (see below).

## Environments — clone a whole stack with its own DB + port

The **Environment** card (top of the Database tab) lists every Moqui devkit can see — your running
instances *and* any clones — and lets you spin up a fresh, isolated one with **Clone active env**:

- **Git worktrees** of the framework, runtime, and every component (a new `env/<name>` branch per repo
  from the current commit) assembled into a self-contained nested checkout under `~/moqui-envs/<name>`
  (override with `envsDir` in `devkit.config.json`). This mirrors the manual worktree-stack pattern;
  your flat repos are untouched and stay on their own branches.
- **Its own MySQL database, port, and instance name** — written into the clone's `MoquiDevConf.xml`.
  Pick the DB seed at create time: **copy** the active env's DB (`mysqldump` → identical data),
  **fresh** (base-data load), or **empty** (Moqui fills on boot).
- **Start / Stop / Delete** from the list; **Select** a running clone to point reset/snapshot/revert at
  it — so you can reset and experiment on a throwaway env without touching your main one. **Delete**
  stops it, drops its DB, and removes all the worktrees + `env/<name>` branches (typed-confirm).

> Worktrees check out *committed* refs, so uncommitted edits in your source aren't carried. The first
> `Start` (or `fresh`/reset load) runs a full gradle build — several minutes + CPU — after which the env
> is isolated. Creating a DB needs an admin user with `CREATE DATABASE`; set `db.adminUser` /
> `db.adminPassword` (e.g. `root`) in `devkit.config.json` if your app user lacks it.

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
  "pwaApps": [{ "name": "order-manager", "port": 8106, "dir": "apps/order-manager" }],
  "db": { "password": "moqui", "adminUser": "root", "adminPassword": "" }
}
```

The optional `db` block only feeds the **Database** tab. Everything in it is optional — devkit
auto-detects host/port/database/user/conf from the effective Moqui config. Use `db.password` when the
password isn't discoverable (it's injected via env at runtime), and `db.adminUser`/`db.adminPassword`
when the app user can't `DROP`/`CREATE DATABASE` (e.g. point those at `root`). You can also override
`host`, `port`, `database`, `user`, and `dbConf`.

…or with env vars (no file needed):

| var | purpose |
|---|---|
| `MOQUI_HOME` | explicit Moqui checkout path |
| `MOQUI_RUN_SCRIPT` | a script that `cd`s into the checkout and runs `./gradlew run` |
| `JAVA_HOME` / `JAVA21_HOME` | Java 21 home (default: Homebrew `openjdk@21`) |
| `MOQUI_CONSOLE_PORT` | console port (default `7070`) |
| `MOQUI_CONSOLE_NO_PWA=1` | force Moqui-only mode |

## License

Apache-2.0

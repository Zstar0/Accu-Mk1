# Devbox and dev stacks

The devbox is a Fedora box on the team Tailscale network (`devbox`,
`100.73.137.3`). It runs the `accumark-stack` platform: complete, isolated
copies of WordPress + Postgres + Redis + Integration Service + COA Builder +
Accu-Mk1 (+ legacy SENAITE) restored from a "golden" data snapshot, one
docker compose project per stack, one port block per stack. You get your own
Unix account; everyone's stacks are visible to everyone; you only operate your
own.

## Connect

Tailscale joined and `~/.ssh/config` on your laptop:

```
Host devbox
  HostName 100.73.137.3
  User <your devbox username>
  IdentityFile ~/.ssh/id_ed25519
```

Key-only SSH (passwords are refused). `ssh devbox 'accumark-stack list'`
should show every stack. If `accumark-stack` is not found, add
`~/accumark-stack/bin` to PATH (the provisioning README in your home lists it).

Where things live on the devbox:

| Path | What |
|------|------|
| `~/accumark-stack` | your clone of the platform repo: the CLI + `docker-compose.yml` |
| `~/accumark-repos/<repo>` | your clones of the four app repos; worktrees are made from these |
| `~/worktrees/<repo>-<stack>` | per-stack worktrees the mount script creates |
| `/srv/accumark-stack/state` | shared registry + per-stack dirs (`.env`, `meta.json`, overrides) |
| `/srv/accumark-stack/snapshots` | shared goldens (`golden-*.tar.gz`), newest is used by default |

## Lifecycle

```bash
ssh devbox 'accumark-stack create dennis-copyid --no-knowledge'   # 3-5 min, restores newest golden
ssh devbox 'accumark-stack creds dennis-copyid'                    # URLs + the stackdev login (WP + Mk1)
ssh devbox 'accumark-stack validate dennis-copyid'                 # smoke battery, retry if services still "starting"
.claude/skills/accumark-feature-workflow/scripts/devbox-mount-branch.sh dennis-copyid   # from your laptop worktree: push + mount
ssh devbox 'accumark-stack status dennis-copyid'
ssh devbox 'accumark-stack destroy dennis-copyid --yes'            # when the PR is merged
```

Name stacks `<you>-<slug>` (lowercase, `[a-z0-9-]`, 16 chars max).

Every created stack has one dev admin login that works on both WordPress and
Accu-Mk1: `stackdev` / `stackdev@accumark.local`, password per stack, printed
by `create` and again by `creds`. Both apps show an amber `DEV STACK <name>`
bar with links to WP, Mk1, Mailhog and IS, so you always know which tab is
which. Emails go to the stack's Mailhog, never to real inboxes.

Ports: block `N` owns `5500 + 20*N` .. `+19`. Offsets inside the block:
Postgres +0, Redis +1, Mailhog UI +2, IS +5, COA Builder +8, Mk1 backend +10,
Mk1 frontend +12, Vite +13, WP +15, SENAITE +18, MinIO +19. `creds` prints the
ones you need; the exact set is the stack's `.env`.

## The edit / test loop from your laptop

1. Edit in your local worktree, run unit tests locally.
2. Commit (pathspec) and run, from inside your worktree,
   `.claude/skills/accumark-feature-workflow/scripts/devbox-mount-branch.sh <stack>`
   (the script ships with this skill in the Accu-Mk1 repo; from another repo's
   worktree call it by its full path, it detects the repo from `origin`).
   First run: pushes, creates `~/worktrees/<repo>-<stack>` on the devbox from
   your branch, mounts it (backend gets `uvicorn --reload`, frontend runs the
   Vite dev server, PHP is per-request). Later runs: pushes and fast-forwards
   the worktree; the running services pick the change up live. Without the
   script the same thing by hand is `git worktree add` on the devbox followed
   by `accumark-stack mount <stack> --mk1 <worktree>` (`--is`, `--coabuilder`,
   `--accumarklabs` for the others).
3. Prove it: `curl` against the stack's ports, or open the stack URLs in a
   browser and screenshot. Put both in the PR.
4. Backend tests against real stack data:
   `ssh devbox 'docker compose -p accumark-<stack> exec -w /app accu-mk1-backend python -m pytest tests/ -q'`.

Mount only the repos you changed. The first Mk1 frontend mount runs
`npm install` inside the container (60 to 120 s); tail
`docker compose -p accumark-<stack> logs -f accu-mk1-frontend`.

## Traps (all found the hard way)

- **`mount` recreates services and re-runs `alembic-init`.** Fine on a fresh
  stack. When you only synced code, do not re-mount; live reload already has
  it. If you must re-mount, expect the Mk1 backend and frontend to restart.
- **Mounting `accumarklabs` hides the dev mu-plugins** (HTTPS strip, WP to IS
  wiring, the DEV STACK bar) because the worktree's `wp-content/mu-plugins`
  is bind-mounted over the container's. Expect an unstyled site over http
  until you re-run the restore's URL-rewrite step, and say so in the PR.
- **`restore` and `create` wipe `wp-content`.** Never restore into a stack
  with an `accumarklabs` worktree mounted: the wipe deletes files in your
  host worktree. `git restore` recovers tracked files only.
- **Native COA generation needs `MK1_PUBLIC_BASE_URL` = the container origin**
  (`http://accu-mk1-backend:8012`, set by the platform). Never point it at a
  host or SPA URL: nginx returns `200 index.html` for `/s2s` paths and the COA
  silently ships HTML as the sample image.
- **WordPress over plain http:** the golden carries prod security plugins that
  force https. The platform disables them on restore; if CSS fails with
  `ERR_SSL_PROTOCOL_ERROR`, that step did not run. Direct SQL writes to WP are
  invisible until `wp cache flush`.
- **`docker compose exec -T` inside a script piped over ssh eats the rest of
  the script.** Redirect its stdin from `/dev/null` or pass commands as ssh
  arguments (the mount script does).
- **Teardown:** the backend container runs as root and leaves root-owned
  `__pycache__` in a mounted worktree, so `git worktree remove --force` fails
  with `Permission denied`. Delete that one directory from a throwaway
  container: `docker run --rm -v $HOME/worktrees:/w alpine rm -rf /w/<repo>-<stack>`,
  then `git -C ~/accumark-repos/<repo> worktree prune`.
- **Windows laptops:** a worktree under `C:/tmp` may carry a `node_modules`
  junction into your main checkout. `cmd /c "rmdir <worktree>\node_modules"`
  before any recursive delete, or you wipe the main checkout's modules.
- **Per-stack `JWT_SECRET`:** encrypted per-user SENAITE passwords from the
  golden cannot be decrypted on a new stack. Irrelevant unless you touch
  SENAITE-mode code paths, which are being phased out.
- **`validate` right after `create` may show services "starting".** Wait 30 s
  and retry; `create` restarts the app services as its last step.

## Never

- Operate on the `host` stack (block 0): it is the Handler's daily environment
  and is managed outside the CLI.
- `destroy`, `unmount`, `restore`, `snapshot create --from` on a stack you did
  not create.
- Point anything at production (`accumk1.valenceanalytical.com`, the Kinsta
  WordPress, the prod droplet). You have no business there.
- Leave stacks running for weeks. Destroy when the PR merges; the Handler
  prunes dormant stacks by request count and will not ask first.

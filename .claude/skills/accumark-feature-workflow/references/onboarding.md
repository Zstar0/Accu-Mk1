# Onboarding: one-time setup

Two checklists. The Handler's side grants access; the developer's side wires
their machine so their Claude Code works the way the team's does.

## Handler's side

1. **GitHub:** write access to `Zstar0/Accu-Mk1`, `integration-service`,
   `coabuilder`, `accumarklabs`, `accumark-stack`.
2. **Tailscale:** invite the developer's device to the tailnet. Cognee and
   the devbox are only reachable from inside it.
3. **Devbox account:** `sudo bash ~/accumark-stack/bin/provision-devbox-user.sh <user> --key '<their ssh public key>'`
   (idempotent; re-run with `--key` to add a key later). Their account joins
   groups `docker` and `accumark` and shares the registry and goldens under
   `/srv/accumark-stack`.
4. **Memory (Cognee on the devbox):** issue them their own API key
   (`POST /api/v1/auth/api-keys` as admin), read access to the `accumark_code`
   and `accumark_company` datasets, never `ownership`. Give them the
   `accumark/cognee-mcp:1.6.1` image (it carries the dataset-id patch and is
   not on a public registry): `docker save accumark/cognee-mcp:1.6.1 | gzip`
   and hand over the file, or push it to a registry they can pull from.
5. **Hand over:** this skill lives in the repo, so nothing to send except the
   API key, the image, the tailnet invite and the devbox username.

## Developer's side

### 1. Claude Code and the three mandatory plugins

```bash
claude plugin install superpowers@claude-plugins-official
claude plugin marketplace add DietrichGebert/ponytail && claude plugin install ponytail@ponytail
claude plugin marketplace add pbakaus/impeccable  && claude plugin install impeccable@impeccable
```

Optional but used by the team: `context7@claude-plugins-official` (library
docs), `code-review@claude-plugins-official`, GitNexus (`AGENTS.md` explains
its `Always Do` rules once installed).

What each does for you: superpowers is the process (brainstorming, TDD,
systematic debugging, verification before completion); ponytail keeps diffs
small and root-caused; impeccable reviews UI changes as you write them.

### 2. Team memory: the `memory-work` MCP server

Docker Desktop must be running; the server is a container that talks to
Cognee on the devbox over Tailscale. Load the image the Handler gave you
(`docker load < cognee-mcp-1.6.1.tar.gz`), then register the server at user
scope with your own key in place of the placeholder:

```bash
claude mcp add-json --scope user memory-work '{
  "type": "stdio",
  "command": "docker",
  "args": ["--context","default","run","-i","--rm",
           "-e","API_URL","-e","API_TOKEN","-e","COGNEE_API_AUTH_SCHEME",
           "-e","TRANSPORT_MODE","-e","COGNEE_MCP_AGENT_SCOPED","-e","COGNEE_MCP_READ_ONLY",
           "accumark/cognee-mcp:1.6.1"],
  "env": {
    "API_URL": "http://100.73.137.3:8000",
    "API_TOKEN": "<your key from the Handler>",
    "COGNEE_API_AUTH_SCHEME": "x-api-key",
    "TRANSPORT_MODE": "stdio",
    "COGNEE_MCP_AGENT_SCOPED": "false",
    "COGNEE_MCP_READ_ONLY": "1"
  }
}'
```

Check: a new session lists `memory-work` under `/mcp` as connected and
exposes a `recall` tool. First-session smoke test: ask Claude to `recall`
"what is the lims_ table prefix rule" from `accumark_code`; a hit proves the
key, the image and the tailnet path. The container takes 10 to 15 seconds to
start cold, so if `/mcp` shows it failed right after Docker Desktop launched,
reconnect it from `/mcp` once Docker is up. There are no memory hooks: recall
is a tool you call at step 1, and the session is not written back (your key
is read-only; the PR is your write path).

### 3. Global instructions

Add to `~/.claude/CLAUDE.md` (create it if missing):

```markdown
## Accumark
- Search memory first: memory-work `recall` on `accumark_code`, then `accumark_company`, BEFORE reading code cold or searching the web. Credit hits as `> **From memory (cognee: <dataset>)** - <facts used>`.
- In any Accumark repo, follow the accumark-feature-workflow skill; no code before the design is approved.
- No em dashes anywhere we write together.
```

### 4. SSH to the devbox

`~/.ssh/config`:

```
Host devbox
  HostName 100.73.137.3
  User <your devbox username>
  IdentityFile ~/.ssh/id_ed25519
```

Then, once, on the devbox (`ssh devbox`):

```bash
gh auth login                                   # device flow; needed for private clones
git config --global user.name  "<Your Name>"
git config --global user.email "<you@example.com>"
git clone git@github.com:Zstar0/accumark-stack.git ~/accumark-stack
for r in Accu-Mk1 integration-service coabuilder accumarklabs; do
  git clone git@github.com:Zstar0/$r.git ~/accumark-repos/$r
done
~/accumark-stack/bin/accumark-stack list        # everyone's stacks appear
```

`~/README-accumark.txt` in your devbox home repeats these.

### 5. Local clones

Clone the repos you will work on to your laptop. Do your editing in worktrees
made from those clones (see `pr-contract.md`), never in the clones
themselves. Accu-Mk1 is npm only: `npm install` once in the clone; on Windows
a worktree can junction `node_modules` from the clone.

### 6. First stack

```bash
ssh devbox 'accumark-stack create <you>-hello'
ssh devbox 'accumark-stack creds <you>-hello'
```

Log into WordPress and Mk1 with the printed `stackdev` login, find the amber
`DEV STACK` bar, then `destroy <you>-hello --yes`. You are set up.

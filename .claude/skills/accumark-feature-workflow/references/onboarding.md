# Onboarding: one-time setup

Two checklists. The Handler's side grants access; the developer's side wires
their machine so their Claude Code works the way the team's does.

## Handler's side

1. **GitHub:** write access to `Zstar0/Accu-Mk1`, `integration-service`,
   `coabuilder`, `accumarklabs`, `accumark-stack`.
2. **Tailscale:** invite the developer's device to the tailnet.
3. **Devbox account:** `sudo bash ~/accumark-stack/bin/provision-devbox-user.sh <user> --key '<their ssh public key>'`
   (idempotent; re-run with `--key` to add a key later). Their account joins
   groups `docker` and `accumark` and shares the registry and goldens under
   `/srv/accumark-stack`.
4. **Hindsight:** issue them a Hindsight Cloud token for the team org. Their
   bank is the default per-repo one (`coding-agent::Accu-Mk1`), not the
   Handler's mixed `obisdian` bank.
5. **Hand over:** this skill lives in the repo, so nothing to send except the
   token, the tailnet invite and the devbox username.

## Developer's side

### 1. Claude Code and the four mandatory plugins

```bash
claude plugin install superpowers@claude-plugins-official
claude plugin marketplace add DietrichGebert/ponytail && claude plugin install ponytail@ponytail
claude plugin marketplace add pbakaus/impeccable  && claude plugin install impeccable@impeccable
npx @vectorize-io/hindsight-coding-agents install claude-code
```

Optional but used by the team: `context7@claude-plugins-official` (library
docs), `code-review@claude-plugins-official`, GitNexus (`AGENTS.md` explains
its `Always Do` rules once installed).

What each does for you: superpowers is the process (brainstorming, TDD,
systematic debugging, verification before completion); ponytail keeps diffs
small and root-caused; impeccable reviews UI changes as you write them;
Hindsight is the shared long-term memory.

### 2. Hindsight config

`~/.hindsight/coding-agent.json`:

```json
{
  "apiUrl": "https://api.hindsight.vectorize.io",
  "apiToken": "<token from the Handler>"
}
```

Leave bank routing at its default. On your first session in a repo, seed the
bank: ask Claude to `hindsight_ingest_document` the contents of
`references/pitfalls.md` and `references/devbox-stacks.md` from this skill so
they are searchable before you need them. From then on the plugin retains
each session automatically; ingest durable findings deliberately.

### 3. Global instructions

Add to `~/.claude/CLAUDE.md` (create it if missing):

```markdown
## Accumark
- Search memory (hindsight_search_knowledge_pages, then hindsight_reflect) BEFORE reading code cold or searching the web.
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

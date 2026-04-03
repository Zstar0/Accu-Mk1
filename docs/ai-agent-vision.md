# AI Agent Vision for AccuMark

## Context

AccuMark is a Tauri + React + FastAPI LIMS desktop app with 100+ API endpoints covering sample intake, HPLC analysis, worksheets, COA generation, and order management. The integration-service adds webhook orchestration connecting SENAITE, WordPress, S3, and Slack. The goal is to bring an AI agent into this ecosystem as a **first-class citizen** — one that understands the domain, can answer questions about live data, and can execute lab operations on behalf of users.

---

## The Three Access Surfaces

An AccuMark AI agent should be reachable from **three surfaces**, all sharing the same brain:

### 1. In-App Chat Panel (primary)
A chat drawer/panel inside the Tauri app itself. The analyst clicks a chat icon, types natural language, and the agent responds with data, actions, or guidance — without leaving their workflow.

- Built with the **Anthropic SDK** (`@anthropic-ai/sdk`) directly
- Runs in the FastAPI backend as a new `/agent/chat` endpoint
- Frontend sends user message → backend runs the tool loop → streams response back
- Has full access to the authenticated user's context (who they are, their role, their SENAITE credentials)

### 2. MCP Server (CLI power users / Claude Code)
An MCP server that exposes AccuMark's domain operations as tools. Any MCP-compatible agent (Claude Code, custom agents) can discover and use them.

- Registered as an MCP server in `.mcp.json`
- Tools like `get_worksheet_items`, `create_sample_prep`, `check_sample_age` become callable from Claude Code CLI
- Great for power users, automation scripts, and batch operations

### 3. Quick Pane (already exists in Tauri)
The existing Quick Pane Tauri window (global shortcut, floating panel) becomes the AI's "Spotlight" — type a question from anywhere on your desktop, get an answer.

- Already has `init_quick_pane`, `toggle_quick_pane`, `submit_quick_pane_text` Tauri commands
- Currently just sends text to the main window — rewire it to send to the agent instead

---

## Tool Design (The Agent's Hands)

The agent's power comes from its **tools** — structured operations it can call. These map directly to existing FastAPI endpoints but are wrapped with domain-aware descriptions that help the LLM choose correctly.

### Data Query Tools
| Tool | Maps To | Example Prompt |
|------|---------|----------------|
| `search_samples` | `GET /senaite/samples` | "Find all samples for order ORD-2024-0451" |
| `get_sample_details` | `GET /wizard/senaite/raw-fields/{id}` | "What's the current status of sample BA-00123?" |
| `get_worksheet_items` | `GET /worksheets` + items | "What is Sarah working on right now?" |
| `get_inbox_samples` | `GET /worksheets/inbox` | "How many samples are waiting in received state?" |
| `get_sample_age` | `GET /worksheets/inbox` + time calc | "How long has BA-00123 been waiting?" |
| `get_analysis_history` | `GET /wizard/sessions` | "Show me the last 5 HPLC analyses run today" |
| `get_instruments` | `GET /instruments` | "Which instruments are currently active?" |
| `get_methods` | `GET /hplc/methods` | "What methods are available for peptide X?" |
| `get_calibration_curves` | `GET /peptides/{id}/calibrations` | "Is the calibration for GLP-1 still active?" |
| `get_order_status` | integration-service explorer | "What's the status of order ORD-2024-0451?" |
| `get_audit_log` | `GET /audit` | "Who last modified sample BA-00123?" |

### Action Tools
| Tool | Maps To | Example Prompt |
|------|---------|----------------|
| `create_sample_prep` | `POST /sample-preps` | "Create a new sample prep for BA-00123" |
| `assign_to_worksheet` | `POST /worksheets/{id}/add-group` | "Add BA-00123 to worksheet WS-042" |
| `set_sample_priority` | `PUT /worksheets/inbox/{id}/priority` | "Mark BA-00123 as expedited" |
| `assign_analyst` | `PUT /worksheets/inbox/bulk` | "Assign all pending peptide samples to Sarah" |
| `create_worksheet` | `POST /worksheets` | "Create a new worksheet for today's GLP-1 batch" |
| `complete_worksheet` | `POST /worksheets/{id}/complete` | "Mark worksheet WS-042 as complete" |
| `trigger_coa_generation` | integration-service webhook | "Generate the COA for BA-00123" |
| `send_slack_notification` | integration-service `/v1/slack` | "Notify the team that the GLP-1 batch is ready for review" |

### Analytical Tools (computed, not just CRUD)
| Tool | What It Does | Example Prompt |
|------|-------------|----------------|
| `calculate_sla_status` | Compute time-in-state for inbox samples, flag overdue | "Which samples are approaching SLA breach?" |
| `summarize_daily_workload` | Aggregate worksheets, inbox, completions | "Give me a summary of today's lab activity" |
| `compare_calibration_curves` | Fetch and compare R-squared, drift | "How has the GLP-1 calibration trended this month?" |
| `analyst_productivity` | Aggregate completions per analyst | "How many samples did each analyst complete this week?" |
| `identify_bottlenecks` | Find oldest samples, busiest instruments | "Where are the bottlenecks right now?" |

---

## Architecture: How It Fits Together

```
                    +-------------------+
                    |   Anthropic API   |
                    |  (Claude model)   |
                    +--------+----------+
                             |
                    +--------v----------+
                    |  Agent Orchestrator|  ← New module in FastAPI backend
                    |  (tool loop,       |
                    |   streaming,       |
                    |   conversation     |
                    |   memory)          |
                    +---+-----+---------+
                        |     |
           +------------+     +-------------+
           |                                |
    +------v-------+              +---------v--------+
    | AccuMark API |              | Integration Svc  |
    | (FastAPI)    |              | (FastAPI)        |
    | 100+ endpoints|             | Webhooks, S3,    |
    +------+-------+              | SENAITE, Slack   |
           |                      +---------+--------+
    +------v-------+                        |
    |  PostgreSQL  |              +---------v--------+
    |  (local DB)  |              | External Systems |
    +--------------+              | SENAITE, WP, S3  |
                                  +------------------+
```

### Key Design Decisions

**1. Agent lives in the FastAPI backend, not the frontend**
- The backend already has all the data access, auth, and business logic
- Keeps the Anthropic API key server-side (security)
- Frontend just sends/receives chat messages via WebSocket or SSE
- Same agent serves in-app chat, Quick Pane, and MCP

**2. Tool definitions are shared between MCP server and in-app agent**
- Define tools once as Python functions with Pydantic schemas
- MCP server exposes them as MCP tools
- In-app agent uses them as Anthropic tool_use definitions
- Single source of truth for what the agent can do

**3. Conversation context includes user identity**
- System prompt includes: who the user is, their role, their permissions
- Agent respects the same RBAC as the UI (admin vs standard user)
- Audit log captures agent-initiated actions with `initiated_by: agent, on_behalf_of: user_id`

**4. Streaming responses via SSE (Server-Sent Events)**
- FastAPI backend streams Claude's response tokens to the frontend
- Frontend renders incrementally (like ChatGPT)
- Tool calls are shown as "thinking" steps the user can expand
- Final answer appears as natural text

---

## Conversation Memory & Context

### Per-Session Context (injected into system prompt)
```
You are AccuMark AI, a lab operations assistant.

Current user: Sarah Chen (analyst, standard role)
Current time: 2026-04-02 14:32 EST
Active worksheets: WS-041 (12 items, 3 complete), WS-042 (8 items, 0 complete)
Inbox summary: 23 samples waiting, 4 expedited, oldest: 6.2 hours
```

### Cross-Session Memory
- Store conversation summaries in a new `agent_conversations` table
- Key facts extracted and persisted (e.g., "user prefers GLP-1 samples grouped by lot")
- Memory is per-user, queryable by the agent on future sessions

---

## What This Unlocks (User Stories)

### For Analysts
> "What should I work on next?"
→ Agent checks inbox priority, SLA timers, user's current worksheets, and recommends the most urgent item.

> "Create a sample prep for BA-00456 using method HPLC-GLP1-v3"
→ Agent validates the sample exists, checks the method is compatible, creates the prep, and confirms.

> "How long has the GLP-1 batch been sitting?"
→ Agent queries inbox, calculates time since received, warns if approaching SLA.

### For Supervisors
> "Give me a morning briefing"
→ Agent summarizes: overnight completions, current inbox depth, analyst assignments, any SLA breaches, instrument status.

> "Who completed the most analyses this week?"
→ Agent queries audit log and worksheet completions, presents a ranked summary.

> "Move all unassigned peptide samples to Sarah's worksheet"
→ Agent identifies unassigned samples with peptide service groups, creates or updates worksheet, confirms count.

### For Quality/Compliance
> "Show me the audit trail for BA-00123"
→ Agent pulls audit log entries, status change events from integration-service, and presents a timeline.

> "When was the last calibration for GLP-1 and is it still valid?"
→ Agent checks calibration curves, R-squared, date, and flags if recalibration is needed.

---

## Implementation Phases (Rough Sketch)

### Phase 1: Foundation
- New `AccuMarkAgent` class in FastAPI backend using Anthropic SDK
- Tool definitions for the top 5-6 read-only query tools
- SSE streaming endpoint (`GET /agent/chat/stream`)
- Basic chat panel in the React frontend (drawer component)
- System prompt with user context injection

### Phase 2: Actions
- Add write tools (create prep, assign worksheet, set priority)
- Confirmation flow: agent proposes action → user confirms → agent executes
- Audit logging for all agent-initiated mutations
- Integration-service query tools (order status, COA status)

### Phase 3: Intelligence
- Computed/analytical tools (SLA analysis, bottleneck detection, workload summary)
- Cross-session memory (conversation history, user preferences)
- Quick Pane integration (rewire existing Tauri command)
- MCP server for CLI access

### Phase 4: Proactive
- Agent-initiated notifications ("Sample BA-00456 has been in received state for 8 hours")
- Scheduled briefings (morning summary via Slack or in-app)
- Anomaly detection (unusual calibration drift, instrument errors)

---

## Why Not Fork Claude Code?

The claude-code-source repo is impressive but **wrong tool for this job**:
- It's a CLI-first terminal UI (React + Ink), not embeddable in a desktop app
- Tightly coupled to Anthropic's infrastructure (OAuth, MDM, telemetry)
- Proprietary/unlicensed — legal risk
- Designed for code editing, not domain-specific LIMS operations

**What to steal from it:**
- The **tool loop pattern** (QueryEngine.ts): send message → get tool_use → execute → feed result back → repeat
- The **tool definition pattern**: schema + description + permission + execution in one unit
- The **MCP server pattern**: expose your domain as MCP tools for external agents
- The **streaming pattern**: SSE/WebSocket for incremental response rendering
- The **permission model**: confirmation before destructive actions

**What to use instead:**
- **Anthropic SDK** (`@anthropic-ai/sdk` or `anthropic` Python package) directly
- Build a lean tool loop (~200 lines of Python) that does exactly what AccuMark needs
- No 500K lines of CLI infrastructure

---

## Key Technical Considerations

1. **Anthropic API key management** — Store in env var on the backend, never expose to frontend
2. **Cost control** — Cache frequent queries (inbox summary, instrument list), use haiku for simple lookups, sonnet/opus for complex reasoning
3. **Rate limiting** — Limit agent calls per user per minute to prevent runaway costs
4. **Confirmation UX** — For any mutation, show a preview card: "I'll create a sample prep with these parameters: [details]. Confirm?"
5. **Fallback** — If the agent can't understand, it should surface the relevant UI page: "I'm not sure about that, but you can check the Worksheets page"
6. **Token efficiency** — Don't dump entire database tables into context. Tools should return focused, pre-filtered results.

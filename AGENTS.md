# AI Agent Instructions

## Overview

This repository is a template with sensible defaults for building Tauri React apps.

## Core Rules

### New Sessions

- Read @docs/tasks.md for task management
- Review `docs/developer/architecture-guide.md` for high-level patterns
- Check `docs/developer/README.md` for the full documentation index
- Check git status and project structure

### Development Practices

**CRITICAL:** Follow these strictly:

0. **Use npm only**: This project uses `npm`, NOT `pnpm`. Always use `npm install`, `npm run`, etc.
1. **Read Before Editing**: Always read files first to understand context
2. **Follow Established Patterns**: Use patterns from this file and `docs/developer`
3. **Senior Architect Mindset**: Consider performance, maintainability, testability
4. **Batch Operations**: Use multiple tool calls in single responses
5. **Match Code Style**: Follow existing formatting and patterns
6. **Test Coverage**: Write comprehensive tests for business logic
7. **Quality Gates**: Run `npm run check:all` after significant changes
8. **No Dev Server**: Ask user to run and report back
9. **No Unsolicited Commits**: Only when explicitly requested
10. **Documentation**: Update relevant `docs/developer/` files for new patterns
11. **Removing files**: Always use `rm -f`

**CRITICAL:** Use Tauri v2 docs only. Always use modern Rust formatting: `format!("{variable}")`

## Architecture Patterns (CRITICAL)

### State Management Onion

```
useState (component) → Zustand (global UI) → TanStack Query (persistent data)
```

**Decision**: Is data needed across components? → Does it persist between sessions?

### Performance Pattern (CRITICAL)

```typescript
// ✅ GOOD: Selector syntax - only re-renders when specific value changes
const leftSidebarVisible = useUIStore(state => state.leftSidebarVisible)

// ❌ BAD: Destructuring causes render cascades (caught by ast-grep)
const { leftSidebarVisible } = useUIStore()

// ✅ GOOD: Use getState() in callbacks for current state
const handleAction = () => {
  const { data, setData } = useStore.getState()
  setData(newData)
}
```

### Static Analysis

- **React Compiler**: Handles memoization automatically - no manual `useMemo`/`useCallback` needed
- **ast-grep**: Enforces architecture patterns (e.g., no Zustand destructuring). See `docs/developer/static-analysis.md`
- **Knip/jscpd**: Periodic cleanup tools. Use `/cleanup` command (Claude Code)

### Event-Driven Bridge

- **Rust → React**: `app.emit("event-name", data)` → `listen("event-name", handler)`
- **React → Rust**: Use typed commands from `@/lib/tauri-bindings` (tauri-specta)
- **Commands**: All actions flow through centralized command system

### Tauri Command Pattern (tauri-specta)

```typescript
// ✅ GOOD: Type-safe commands with Result handling
import { commands } from '@/lib/tauri-bindings'

const result = await commands.loadPreferences()
if (result.status === 'ok') {
  console.log(result.data.theme)
}

// ❌ BAD: String-based invoke (no type safety)
const prefs = await invoke('load_preferences')
```

**Adding commands**: See `docs/developer/tauri-commands.md`

### Internationalization (i18n)

```typescript
// ✅ GOOD: Use useTranslation hook in React components
import { useTranslation } from 'react-i18next'

function MyComponent() {
  const { t } = useTranslation()
  return <h1>{t('myFeature.title')}</h1>
}

// ✅ GOOD: Non-React contexts - bind for many calls, or use directly
import i18n from '@/i18n/config'
const t = i18n.t.bind(i18n)  // Bind once for many translations
i18n.t('key')                 // Or call directly for occasional use
```

- **Translations**: All strings in `/locales/*.json`
- **RTL Support**: Use CSS logical properties (`text-start` not `text-left`)
- **Adding strings**: See `docs/developer/i18n-patterns.md`

### Documentation & Versions

- **Context7 First**: Always use Context7 for framework docs before WebSearch
- **Version Requirements**: Tauri v2.x, shadcn/ui v4.x, Tailwind v4.x, React 19.x, Zustand v5.x, Vite v7.x, Vitest v4.x

## Developer Documentation

For complete patterns and detailed guidance, see `docs/developer/README.md`.

Key documents:

- `architecture-guide.md` - Mental models, security, anti-patterns
- `state-management.md` - State onion, getState() pattern details
- `tauri-commands.md` - Adding new Rust commands
- `static-analysis.md` - All linting tools and quality gates

## Claude Code Commands & Agents

These are specific to Claude Code but documented here for context.

### Commands

- `/check` - Check work against architecture, run `npm run check:all`, suggest commit message
- `/cleanup` - Run static analysis (knip, jscpd, check:all), get structured recommendations
- `/init` - One-time template initialization

### Agents

Task-focused agents that leverage separate context for focused work:

- `plan-checker` - Validate implementation plans against documented architecture
- `docs-reviewer` - Review developer docs for accuracy and codebase consistency
- `userguide-reviewer` - Review user guide against actual system features
- `cleanup-analyzer` - Analyze static analysis output (used by `/cleanup`)

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Accu-Mk1** (6433 symbols, 10925 relationships, 278 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Accu-Mk1/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Accu-Mk1/clusters` | All functional areas |
| `gitnexus://repo/Accu-Mk1/processes` | All execution flows |
| `gitnexus://repo/Accu-Mk1/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->

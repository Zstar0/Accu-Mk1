# Flags — User Guide

## At a glance

Flags are how Accu-Mk1 keeps work moving without losing the thread in Slack. A **flag** is a small ticket pinned to a specific piece of work — a sample, a vial, or a worksheet — with an owner, a status, and a comment thread. Instead of "hey, did anyone re-run P-0134?" scrolling off in a channel, you raise a flag on P-0134, assign it, and everyone who cares can see exactly where it stands.

> **The one-minute version:**
>
> - A flag lives **on a work item** (sample / vial / worksheet), not in a channel — open the item and the flag is right there.
> - Every flag has a **type** (an Issue like *Blocker* or *Question*, or a Signal like *Ready for Verification*), an **assignee**, **watchers**, a **status**, and a **comment thread**.
> - The **Flags button** (top-right, next to Worksheets) opens a slide-out with everything relevant to you — what's assigned to you, what you raised, what you're watching, and what's new.
> - **@mention** someone in a comment to pull them in as a watcher.
> - Move a flag through its **status** (Open → In Progress → Blocked → Resolved → Closed) so its state is never a mystery.

Read this once end-to-end; after that the flyout and the flag buttons are self-explanatory.

## Anatomy of a flag

Every flag has the same parts, whether it's a blocker on a vial or a "ready for verification" signal on a sample:

| Part | What it is |
| --- | --- |
| **Title** | A one-line summary of what's going on ("HPLC re-run needed — baseline drift"). |
| **Type** | The kind of flag. Types are one of two **kinds**: an **Issue** (something's wrong / needs a decision) or a **Signal** (a heads-up / status). See below. |
| **Entity** | The work item it's attached to — a sample, a vial (sub-sample), or a worksheet. The flag shows the item's real label and links straight to it. |
| **Assignee** | The one person who owns moving it forward. Optional, but a flag with no owner tends to sit. |
| **Watchers** | People kept in the loop: the person who raised it, the assignee, and anyone @mentioned. |
| **Status** | Where it is in its lifecycle: Open, In Progress, Blocked, Resolved, or Closed. |
| **Comments** | A threaded discussion, with system lines (raised / assigned / status changes) woven in for a full history. |

### Issue vs Signal

- **Issue** — something needs attention or a decision. Types include **Blocker**, **Critical**, **Question**, and **Waiting on Customer**.
- **Signal** — a status broadcast, not a problem. The main one is **Ready for Verification**.

Your lab's exact list of types is managed by an admin (see *For admins* below), so what you see in the type picker may differ slightly from the defaults.

## Raising a flag

You almost never type in an entity ID — you raise a flag **from the work item itself**, so it's already attached to the right thing.

<!-- screenshot: A sample details page showing the flag button in the header -->

**From a sample, vial, or worksheet:**

1. Open the item (a sample's detail page, a vial row, or the worksheet drawer).
2. Click its **flag button**. If the item already has flags, the button is colored and shows a count; if not, it's a subtle outline.
3. Choose **Raise a flag**, pick the **type**, give it a **title**, optionally assign it, and save.

**From the Flags flyout:**

- When you're on an item's page, the flyout's **Add Flag** button is pre-targeted to that item ("Add flag on P-0134-S02"). If you're not on a specific item, Add Flag is hidden — that's intentional, because nobody memorizes raw entity IDs.

> **Raising several at once:** an item can carry more than one flag. After you raise one, use **Raise another flag** to add the next. The flag button's count badge reflects the total.

## Assigning & watchers

A flag moves fastest when exactly one person owns it.

- **Assignee** — set it when you raise the flag or any time after. The assignee is the person expected to act.
- **Watchers** are added automatically:
    - the person who **raised** the flag,
    - the **assignee**,
    - anyone **@mentioned** in a comment.
- You can watch a flag you weren't pulled into if you want to keep an eye on it — it then shows up under your **Watching** tab.

Who gets a notification depends on the relationship and the per-person notification settings (see *Slack DM notifications*). As a rule: the assignee hears about assignments and status changes; @mentioned people hear about the mention.

## The status lifecycle

Move a flag through its statuses so its state is always obvious at a glance. Colors on the flag chips track the status.

| Status | Meaning — use it when… |
| --- | --- |
| **Open** | Just raised; nobody's actively working it yet. |
| **In Progress** | Someone (usually the assignee) is actively on it. |
| **Blocked** | Work has stalled on something external — waiting on a reagent, an instrument, a customer, another team. Flags the fact that it's *stuck*, not just unstarted. |
| **Resolved** | The work is done; kept visible for a beat so others can confirm. |
| **Closed** | Done and acknowledged; drops out of the "open" views. |

**Open**, **In Progress**, and **Blocked** are all "open" states — they show up in the **All open** tab and count toward the flag badges on items. **Resolved** and **Closed** are done states and drop out of those views.

> **Resolve when it's actually done.** A flag left In Progress forever is as noisy as no flag at all. When the work is complete, move it to Resolved (or Closed) so it clears from everyone's open lists.

## Comments & @mentions

Each flag has a **thread**. Use it the way you'd use a Slack thread — but it stays pinned to the work.

- Type a comment and send; it animates into the thread.
- **@mention** a colleague (`@Jane`) to pull them in. They become a **watcher** and get notified about the mention.
- **System lines** — raised, assigned, status changes — are woven into the thread in grey, so the comment history and the audit history are one continuous story. That audit trail is also there for traceability.

## The Flags flyout

The **Flags button** sits at the top-right, next to Worksheets. It shows colored count chips and glows when something new arrives. Click it to open the full-height slide-out.

<!-- screenshot: The Flags flyout open, showing the tab row and a list of flags -->

**Tabs** (each scoped to what's relevant to you):

| Tab | Shows |
| --- | --- |
| **Assigned to me** | Flags you own. |
| **Raised by me** | Flags you created. |
| **Watching** | Flags you're a watcher on. |
| **All open** | Every open flag across the lab (Open / In Progress / Blocked). |
| **Activity** | A running feed of recent flag events relevant to you. |
| **Unread** | Flags with activity you haven't looked at yet. |

**Other flyout controls:**

- **List / Table view** — toggle between stacked cards and a dense table; your choice is remembered.
- **Filter bar** — search by title or Sample ID, and filter by status or entity type.
- **Unread markers** — a magenta marker flags threads with new activity; open one to clear it.
- Clicking a flag opens its **thread**; from there you can comment, assign, and change status.

> **A colored count on an item?** If you're looking at a sample, vial, or worksheet and its flag button shows a number, that's how many flags are on it. Click it: one flag opens the thread directly; several open a short scoped list.

## Flags on your work

Flags surface wherever you assess work, not only in the flyout:

- **Sample details** — a flag button in the header. On a parent sample it **aggregates its vials' flags**, so you see the whole picture from the top.
- **Vials** — each vial row has its own flag affordance.
- **Worksheets** — the worksheet drawer header carries a flag button for that worksheet.
- **Order & customer views** — a flag indicator appears next to samples in the Order Status table and customer detail, so a coordinator can spot a flagged order at a glance.

Everywhere, the **count badge** tells you how many flags are on the item, and the color reflects the most important one.

## Slack DM notifications

You can have flag activity mirrored to you as **Slack direct messages** — the same things that would toast you in the app.

- It's **opt-in per person**. Set it up under **Account → Profile**: link your Slack account (or paste your Slack member ID), send a **test DM** to confirm it works, and toggle the categories you want (assigned to you, mentioned, activity on flags you raised, activity on flags you watch, status changes).
- **Watchers don't get live DMs for every ripple** by design — watching keeps you in the loop without drowning you.
- Each DM deep-links back to the flagged item and opens the thread.

> If you never set this up, nothing changes — flags still work entirely in the app. Slack DMs are a convenience layer on top.

## For admins — managing flag types

Admins control the catalog of flag **types** (labels, colors, which are Issues vs Signals, which count as *blocking*, and which entity types they apply to).

<!-- screenshot: The Preferences dialog open to the Flags pane, showing the type list -->

- Open **Preferences → Flags**.
- **Create or edit a type:** set its label, color, kind (Issue / Signal), whether it's blocking, and its scope (global, or restricted to samples / vials / worksheets).
- **Deactivating a type** (not deleting) is the norm: a type that's still in use can't be hard-deleted, but you can **deactivate** it — it disappears from the raise picker while existing flags keep rendering. This keeps the audit history intact.
- The type **slug** is fixed once created (existing flags reference it); you can rename the label freely.

## Tips & etiquette

- **One owner per flag.** Assign it. Unowned flags drift.
- **Resolve when done.** Clear finished work out of everyone's open lists.
- **Use Signal for status, Issue for problems.** "Ready for Verification" is a Signal; "Blocker" is an Issue. Picking the right kind keeps the views meaningful.
- **@mention to pull someone in**, rather than re-explaining context in Slack — the flag already has the context and the link to the work.
- **Don't over-flag.** A flag is for something that needs tracking or a hand-off, not for every routine step.

## Glossary

- **Flag:** A mini-ticket pinned to a work item (sample, vial, or worksheet), with a type, assignee, watchers, status, and comment thread.
- **Kind:** Whether a flag type is an **Issue** (needs attention/decision) or a **Signal** (a status broadcast).
- **Type:** The specific label within a kind — e.g. Blocker, Critical, Question, Waiting on Customer (Issues); Ready for Verification (Signal). Managed by admins.
- **Entity:** The work item a flag is attached to. A parent sample aggregates its vials' flags.
- **Assignee:** The single person who owns moving a flag forward.
- **Watcher:** Someone kept in the loop — the raiser, the assignee, and anyone @mentioned.
- **Blocked:** An open status meaning work is stalled on something external, distinct from simply not-yet-started.
- **Signal (Ready for Verification):** A flag kind used to broadcast that work is ready for the next step, rather than to report a problem.

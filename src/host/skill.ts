/**
 * The `dsh-kanban` skill, registered at runtime by the plugin.
 *
 * It is registered in code rather than written to `~/.dsh/skills/dsh-kanban/SKILL.md` on purpose:
 * a skill file and a tool set are two homes for one fact, and they drift. Registered here, the
 * procedure ships with the tools it describes, disappears when the plugin is disabled, and cannot
 * describe a tool that is not there. The one-line router entry in `AGENTS.md` points at this.
 *
 * The text is written for an agent that has never seen the board and is about to move a card.
 */
export const SKILL_NAME = 'kanban';

export const SKILL_DESCRIPTION =
  'Work the shared task board: list, read, create, refine, move, assign, block and drop cards, and run sprints — with the WIP limits, Definition of Ready and Definition of Done the board enforces.';

export const SKILL_WHEN_TO_USE =
  'kanban, board, backlog, sprint, move task, prioritise, priority, assign, blocked, WIP, cycle time, what should I work on';

export const SKILL_CONTENT = `# Working the Kanban board

The board lives at \`$DSH_HOME/.kanban/board.db\` and is shared: Dhira moves the same cards by hand in
the Kanban panel. The SQLite file is the only copy — there is no Markdown view and no per-card
folder to keep in step, so never hand-edit the database: edit the board through the tools. Every
mutation you make is one row plus one event, so the flow metrics stay honest.

## The five things to know before you move anything

1. **Work starts in \`backlog\` and only leaves it when the Definition of Ready is ticked**
   (\`outcome\`, \`acceptance\`, \`write-scope\`, \`estimate\`). \`kanban_move\` refuses otherwise and names
   the unticked checks. Tick them with \`kanban_update\`'s \`check\` action as you learn the answers —
   that is refinement, and it is the point.
   **\`write-scope\` is data, not a judgement.** Put the scope on the card — \`kanban_create\` and
   \`kanban_update\` both take \`writeScope\`, one workspace-relative file or directory prefix or a
   list of them — and the item is satisfied; you do not have to tick it as well. A card with no
   recorded scope is refused **by name**, and that refusal is the board asking for the field.
2. **WIP is controlled**: \`in-progress\` holds 2, \`review\` holds 1. When a column is full, the move
   is refused. That is the board working, not an obstacle: finish something, or ask Dhira to
   expedite — you may not expedite for yourself.
3. **Priority, class of service and every gate exception are Dhira's.** You may propose a priority
   in a comment (\`kanban_update\`, action \`comment\`) and you may not set it. \`p0-critical\` through
   \`p4-someday\`, and \`expedite\` as the only WIP exception, are his call.
4. **\`done\` needs the Definition of Done ticked** with real evidence: a command's output, a test
   result, a screenshot. "It looks right" is not a DoD. If an item does not meet the DoD it goes
   back to the backlog, not into \`done\`.
5. **A blocked card stays where it is**: block it with a reason instead of parking it in a column it
   has not reached, so it keeps counting as WIP and keeps ageing in front of you.

## The tools

| tool | use it for |
|---|---|
| \`kanban_list\` | the board: filter by state, assignee, project, workspace, sprint, tag, priority, blocked, or free text. Start here. |
| \`kanban_get\` | one card in full: checklists, comments, history. |
| \`kanban_create\` | a new card, with a title, an optional template and its \`writeScope\`. It starts in \`backlog\`. |
| \`kanban_update\` | prose, metadata, assignment, tags, links, \`writeScope\` — and \`check\` to tick a DoR/DoD item, \`comment\` to say something, \`block\`/\`unblock\`. |
| \`kanban_move\` | change column. This is the one that enforces the gates and the WIP limits. |
| \`kanban_delete\` | \`drop\` with a reason (kept in the metrics), or \`purge\` — which only Dhira may do. |
| \`kanban_sprint\` | create, start, close or cancel a sprint. A sprint is 31 days or less and has a goal. |
| \`kanban_board\` | views, templates and the Definition of Workflow. |
| \`kanban_metrics\` | WIP, throughput, work item age, cycle time and the SLE. |

## How to run a piece of work

1. \`kanban_list\` with \`state: ["ready"]\` — the columns that may be pulled.
2. Refine the top candidate until its DoR is ticked (\`kanban_update\` with \`check\`).
3. \`kanban_move\` to \`in-progress\`, and \`kanban_update\` \`assignee\` to yourself.
4. Do the work. Record the evidence as you get it — a card with no evidence is a card that will not
   pass its own DoD.
5. \`kanban_move\` to \`review\`. If the work is finished, tick the DoD and move to \`done\`.
6. If a correction landed, write it in \`~/.dsh/memory/lessons.md\` before closing the card; the DoD asks.

## When not to use the board

The board holds work with a state and a future — the day's task list does not belong here.
For within-turn planning use \`todo_write\`, which is per-session and disposable; for anything that
must survive the session, and anything Dhira should see, use the board.
`;

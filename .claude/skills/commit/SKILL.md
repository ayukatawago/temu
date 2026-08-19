---
name: commit
description: This skill should be used when the user asks to "commit", "create a commit", "commit my changes", "commit staged changes", or wants to commit work following the project convention. Creates a Conventional Commits-formatted git commit.
---

Create a git commit following temu's Conventional Commits convention.

## Convention

Format: `type: brief description`

| Type       | When to use                                                    |
| ---------- | -------------------------------------------------------------- |
| `feat`     | New user-visible feature or capability                         |
| `fix`      | Bug fix                                                        |
| `chore`    | Build config, tooling, deps, scaffolding — no production logic |
| `refactor` | Code restructuring without behaviour change                    |
| `test`     | Adding or updating tests                                       |
| `docs`     | Documentation only                                             |
| `ci`       | CI/CD pipeline changes                                         |

Rules:

- Lowercase throughout
- Imperative mood ("add X", not "added X" or "adds X")
- No trailing period
- Max 72 characters for the title line
- Always append the `Co-authored-by` trailer

## Body (optional, between title and footer)

Leave the body empty when the title is self-explanatory. Include it when:

- The **why** is not obvious from the diff (e.g. a workaround for a known library bug, a constraint imposed by a dependency)
- The change has **non-trivial motivation** a future reader would wonder about
- A **breaking change** needs explanation

Format:

- Separate from the title with one blank line
- Wrap at ~72 characters per line
- Use imperative mood, same as the title
- Focus on _why_, not _what_ — the diff already shows what changed
- Multiple short paragraphs are fine; do not use bullet lists

```
fix: retry screenrecord after silent eof on emulator restart

The emulator's screenrecord process exits without error when the AVD
is cold-booted mid-stream, so a plain pipe-closed check missed it.
Watch the child's exit event directly instead of relying on stdout eof.

Co-authored-by: Claude Code <claude@anthropic.com>
```

## Workflow

1. Run `git status` and `git diff --cached` to inspect staged changes.
2. If nothing is staged, run `git diff` to see unstaged changes, then ask the user which files to stage (or stage all with their confirmation).
3. **Pre-commit check — run format, lint, then the build; fail fast if anything is wrong:**
   ```sh
   npm run format:check
   npm run lint
   npm run build
   ```
   - If `format:check` reports issues, run `npm run format` to auto-fix, then re-check.
   - If `lint` reports any errors or warnings, stop and fix them before committing.
   - If `build` fails (type errors or otherwise), stop and fix before committing.
   - Only proceed once all three commands pass cleanly.
4. Analyse the diff to determine:
   - The appropriate **type** from the table above
   - A concise **description** in imperative mood that says _what changed and why_, not just _what files changed_
5. If the change is large or spans multiple concerns, propose splitting into separate commits and ask the user.
6. Show the proposed commit message to the user before creating it.
7. Create the commit:

```sh
git commit -m "$(cat <<'EOF'
type: description

Co-authored-by: Claude Code <claude@anthropic.com>
EOF
)"
```

8. Confirm success by showing the one-line git log entry.

## Examples

```
feat: add doctor command and kitty graphics frame renderer
feat: stream live device screen via screenrecord and ffmpeg
fix: recompute cell size after tmux pane resize
chore: scaffold temu cli with typescript, eslint, and prettier
refactor: extract touch coordinate mapping into geometry.ts
docs: document terminal graphics requirements in readme
```

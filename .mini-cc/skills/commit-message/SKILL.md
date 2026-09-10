---
description: Write a git commit message following this project's conventions
---

# Writing a commit message

Run `git diff --staged` first. Never write a message for changes you have not read.

Format: `<type>(<scope>): <subject>` where type is one of feat, fix, refactor,
test, docs, chore. Subject in the imperative, no trailing period, under 60 chars.

Body: explain WHY, not what. The diff already says what. Wrap at 72 columns.
Reference the issue as `Refs #123` on its own line if there is one.

Never mention the tools you used. Never write "various fixes".

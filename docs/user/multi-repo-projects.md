# Projects with several repositories

A project can cover more than one repository, so one thread can read and change all of them. This
fits two common setups:

- A plain folder that holds several repositories, such as `shop/api` and `shop/web`.
- A repository that works alongside others it depends on, anywhere on the machine.

The project folder does not have to be a Git repository itself.

## Which repositories a project covers

There is no list to keep. A project covers every repository inside its folder: C3 Code looks one
level down, and one level further inside folders that are not repositories themselves, such as
`src` or `packages`. It reads the disk each time, so a repository you clone there is part of the
project straight away, and one you delete is gone from it. Worktrees of another repository and
submodules are left out.

**Settings → Projects → Repositories** shows what the project covers.

### Folders outside the project

A repository somewhere else on the machine has to be added, because adding it lets agents work in a
place they could not reach before.

- Use **Add folder** under **Repositories**.
- If the project folder has a `.code-workspace` file, the folders it lists outside the project are
  offered there with an **Add** button.

**Remove** takes an added folder out of the project. It never deletes files. A project can cover up
to 128 folders.

### Leave a repository out

To keep a repository inside the project folder out of the project, name it in the `t3.json` in the
project folder, relative to that folder:

```json
{
  "ignoreRepositories": ["vendor/big"]
}
```

It is then not reviewed on its own. Because the file is checked in, the choice applies on every
machine.

## What agents see

Codex and Claude are told which folders the project covers, and can write to the ones outside the
thread's folder wherever they can write to the thread's folder. Each repository keeps its own
history: agents run Git commands and commit inside the repository they change.

## Review changes

Each turn lists the files it changed, including those in the project's repositories, and its diff
covers all of them. Paths start at the thread's folder, so the same file name in two repositories
stays apart. See [Review turn changes](source-control.md#review-turn-changes).

## Limits

- Repositories are covered only by threads that work in the project folder. A worktree thread works
  in a single checkout of the project folder, which must itself be a repository.
- Rewinding a thread does not restore the project's repositories: they are shared with every other
  thread of the project, so check their uncommitted changes after a rewind.
- Git actions and the Diff pane's **Uncommitted**, **Changes**, and **Commits** sources read the
  thread's own folder only.
- Only the project folder's `t3.json` is read. Setup scripts and actions inside one of its
  repositories are not picked up.

# Agent notes

## Isolate the task in its own worktree

Every card starts from the repo's default branch in a worktree of its own, never in the shared project checkout.
With **Dedicated workspace per card** on in the project, the run's working directory already is
`<DATA_DIR>/workspaces/<card id>/<folder>` on branch `omp/<card>`, created from the project's default branch
(**Project settings → More options → Default branches**, else the repo's own `origin/HEAD`/`main`/`master`).
Work, commit and ship from there. A fresh worktree has no `node_modules`, so install before building or testing.

If the run starts in the shared project folder — other cards' uncommitted changes are visible there, or the folder
sits on a branch other than the default one — give the card its own worktree before editing anything:

```
cd <project folder>                       # repo top, e.g. /home/ubuntu/omp-ui
git worktree add -b omp/<card id> "<project folder>/data/workspaces/<card id>/<folder name>" <default branch>
```

`GET /api/v1/tasks/<card id>/workspace` reports the exact path and branch the card must use (`isolated: true`).
Never commit in the shared checkout while another card is running in it, and never touch another card's changes.

## Clean up task artifacts

Once the task is done and verified, before committing or pushing and before the final summary, remove everything you
created only for the task: analytics and profiling output, throwaway tests and scripts, test-runner output, Docker
containers, volumes and images, scratch files, background processes, and work-in-progress files in the card folder
that the Report does not link. Keep only the summary with its Report, the files it links, and the changes the task
asked for. Never delete anything you did not create: pre-existing files, user uploads, other cards' changes, Docker
resources that were already there, or permanent infrastructure (`tests/`, `e2e/`, `Dockerfile`, `docker-compose.yml`).
Mark Docker resources you start for the task (`docker compose -p task-<card id>`, `--label agentman.task=<card id>`) and
remove them before finishing; AgentMan removes marked leftovers when a run finishes the card or the card is deleted.
Don't mark a container the task should leave running, or its image.
Full policy: [docs/TASK-CLEANUP.md](docs/TASK-CLEANUP.md).

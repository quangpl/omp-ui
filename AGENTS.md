# Agent notes

## Clean up task artifacts

Once the task is done and verified, before committing or pushing and before the final summary, remove everything you
created only for the task: analytics and profiling output, throwaway tests and scripts, test-runner output, Docker
containers, volumes and images, scratch files, background processes, and work-in-progress files in the card folder
that the Report does not link. Keep only the summary with its Report, the files it links, and the changes the task
asked for. Never delete anything you did not create: pre-existing files, user uploads, other cards' changes, Docker
resources that were already there, or permanent infrastructure (`tests/`, `e2e/`, `Dockerfile`, `docker-compose.yml`).
Mark Docker resources you start for the task (`docker compose -p task-<card id>`, `--label omp-ui.task=<card id>`) and
remove them before finishing; OMP-UI removes marked leftovers when a run finishes the card or the card is deleted.
Don't mark a container the task should leave running, or its image.
Full policy: [docs/TASK-CLEANUP.md](docs/TASK-CLEANUP.md).

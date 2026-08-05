# Runbook: Deploying

There is no deploy script. Merging to `main` is the deploy trigger; the box pulls what CI published.

## The chain

1. **Merge the PR.** That is a push to `main`, which runs CI.
2. **CI publishes** — but only if every lane is green: lint, both test suites, type checks, contract
   drift, the dependency audit, both image builds and the smoke job. Roughly 2–3 minutes. Both
   images build and load before anything is pushed, and both `:<short-sha>` tags go up before either
   `latest` moves, so the two tags can never describe different commits.
3. **Force Update** the `frontdashboard` stack in Unraid's **Compose Manager** plugin. It pulls and
   recreates both containers. "Check for Updates" alone can report up-to-date against a stale
   reference — Force Update is the one that acts.
4. **Verify from outside**, read-only — [Checks after it comes up](#checks-after-it-comes-up) below.

Nothing in this repo reaches the host. The Unraid compose file is maintained by hand there and
should match [docker-compose.prod.yml](../../docker-compose.prod.yml); this repo's copy is the
reference, not the source.

## If the pull fails

The GHCR packages are private, so the host authenticates with a `read:packages` token. That login
lives in `/root/.docker/config.json`, which is on Unraid's RAM disk — a User Scripts entry at array
start re-applies it, and without it a `pull` answers 403 in a way that reads like a missing tag.

If CI is red there is simply nothing to pull, and `latest` still points at the previous build.

## Checks after it comes up

**View Logs** on the stack, and look for:

- `alembic upgrade head` completing. Migrations run at backend startup, so a failed one exits the
  container rather than serving with the wrong schema.
- `Started server process [1]` — uvicorn is PID 1, with no supervisor between it and the signal.
- No restart loop. `BackendRestartLoop` alerts on more than three restarts in an hour.

Then from outside, over HTTPS: the document served `no-cache`, the bundle it names answering
`200 text/javascript`, a deleted asset answering `404` rather than the SPA fallback, and
`/api/health/ready` answering `200`. All `GET`/`HEAD` — never write to production.

## Rolling back

[rollback.md](rollback.md). Pin the previous `:<short-sha>` in the Unraid compose and Force Update
— and read the migration warning there first, because an image rollback does not undo a migration.

## Cloudflare

A static asset that looks stale after a deploy means purge the Cloudflare cache. Never rebuild.

# Runbook: Deploying

There is no deploy script. Merging to `main` is the deploy trigger; the box pulls what CI published.

## The chain

1. **Merge the PR.** That is a push to `main`, which runs CI.
2. **CI publishes** — but only if every lane is green: lint, both test suites, type checks, contract
   drift, the dependency audit, both image builds and the smoke checks. Roughly 3–4 minutes — the grouped jobs trade ~1 minute of wall time for the billing. Both
   images build and load before anything is pushed, and both `:<short-sha>` tags go up before either
   `latest` moves, so the two tags can never describe different commits.
3. **Check for Updates**, then **Update** the `frontdashboard` stack in the host's **Compose Manager**
   plugin. That pulls and recreates the containers. **Force Update** is not the routine path: it
   re-pulls when the plugin reports nothing to do, which is worth reaching for only if an update
   completes and the running image is still the old one.
4. **Verify from outside**, read-only — [Checks after it comes up](#checks-after-it-comes-up) below.

Nothing in this repo reaches the host. The stack lives at `/mnt/user/appdata/stacks/frontdashboard/`
as `compose.yaml`, `compose.override.yaml` and `.env`, maintained by hand there, and should match
[docker-compose.prod.yml](../../docker-compose.prod.yml); this repo's copy is the reference, not the
source. Nothing verifies that they agree, so they have drifted before.

## If the pull fails

The GHCR packages are private, so the host authenticates with a `read:packages` token. That login
lives in `/root/.docker/config.json`, which is on the host's RAM disk — a boot-time script
re-applies it, and without it a `pull` answers 403 in a way that reads like a missing tag.

If CI is red there is simply nothing to pull, and `latest` still points at the previous build.

## If CI never ran

A dropped webhook — an Actions incident, a throttle — leaves a commit on `main` with no run at all,
so nothing was published and `latest` still describes the previous commit. No event replays itself.
Start one by hand: **Actions → CI → Run workflow**, on `main`. The publish job accepts a manual run
on that branch, so a green one moves the tags exactly as a push would.

Check `gh run list --branch main` first — a queued run means the webhook arrived late, not never.

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

[rollback.md](rollback.md). Pin the previous `:<short-sha>` in the prod compose and update the
stack — and read the migration warning there first, because an image rollback does not undo a
migration.

## Cloudflare

A static asset that looks stale after a deploy means purge the Cloudflare cache. Never rebuild.

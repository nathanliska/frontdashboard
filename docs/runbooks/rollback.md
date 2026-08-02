# Runbook: Rolling Back a Deploy

For when a deploy shipped something broken and the fastest fix is the previous build. This is an
image swap — it does **not** undo a migration. Read the migration warning before running it.

## What makes this possible

`deploy.sh` tags every build twice: the mutable tag (`latest`) and an immutable `:<short-sha>`.
Pushing moves `latest` and leaves its predecessor unnamed, so the sha tag is the only durable
handle on a previous build. The script refuses to run against a dirty working tree, because a sha
that doesn't describe what's in the image is worse than no rollback target at all.

**This is not retroactive.** Only builds pushed after that change carry sha tags; anything older
has no target and still has to be rebuilt from its commit.

## Roll back

1. **Find the sha you want.** `git log --oneline` — the tag is the short sha of the commit the
   image was built from. The one you want is usually the deploy before the bad one.

2. **Pin it** in the Unraid compose. Both images move together — a frontend and backend from
   different commits is the one runtime failure the contract gate cannot catch
   ([ADR-018](../adr/ADR-018-generated-validated-contracts.md)).

   ```yaml
   backend:
     image: heatslinger/frontdashboard-backend:abc1234
   frontend:
     image: heatslinger/frontdashboard-frontend:abc1234
   ```

3. **Pull and restart.**

   ```sh
   docker compose --env-file .env.prod -f docker-compose.prod.yml pull
   docker compose --env-file .env.prod -f docker-compose.prod.yml up -d
   ```

4. **Verify from outside.** Document served with `Cache-Control: no-cache`, the bundle it names
   answers `200 text/javascript`, `/api/health/ready` answers `200`. The `deploy-verify` skill is
   this checklist.

5. **Un-pin once fixed.** Put the tag back to `latest` when the fix ships, or the next deploy will
   appear to do nothing.

## The migration warning

**Rolling the image back does not roll the database back.** The backend runs `alembic upgrade head`
at startup, so if the bad deploy applied a migration, the database is now *ahead* of the code you
just rolled back to.

- If the migration was **additive** (new nullable column, new table), older code ignores it and the
  rollback is safe. This is the common case.
- If it **dropped or renamed** something the old code reads, the old code will fail against the new
  schema. Rolling back makes things worse, not better.

Check what the bad deploy migrated before rolling back:

```sh
docker exec frontdashboard-db psql -U frontdashboard -d frontdashboard \
  -c "SELECT version_num FROM alembic_version;"
git log --oneline -- backend/alembic/versions/
```

If a destructive migration is involved, the honest path is forward — fix and deploy again — or a
restore, which is [its own runbook](database-restore.md). `alembic downgrade` exists but is not
rehearsed here, and an unrehearsed downgrade during an outage is not a plan.

## Cloudflare

Asset filenames are content-hashed, so a rollback serves an `index.html` naming the *old* bundles,
which the rolled-back image still contains. The document itself is `no-cache`, so no purge is
needed. If an asset looks stale anyway, purge the Cloudflare cache — never rebuild.

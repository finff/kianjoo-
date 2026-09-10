# Auto-deploy: GitHub `main` → cPanel, on push

`deploy.php` (repo root) is a framework-free webhook receiver. A push to
`main` on GitHub makes it run `git-deploy.sh`, which does `git fetch` +
`git reset --hard origin/main` in place — the cPanel Git repo path *is*
this site's document root, so that's the whole deploy.

This is a **different thing** from the existing `deploy.sh` at the repo
root, which is a local, FTP-based tool a developer runs from their own
machine to mirror files to the (older) tm-next-series FTP host. Nothing
here touches that script or that workflow.

## Register the webhook

GitHub repo → **Settings → Webhooks → Add webhook**:

| Field | Value |
|---|---|
| Payload URL | `https://<HOST>/deploy.php` |
| Content type | `application/json` |
| Secret | the value of `DEPLOY_TOKEN` in the server's `.env` |
| Events | Just the **push** event |

Save it. GitHub immediately sends a `ping` delivery — check
**Recent Deliveries** and confirm it shows a `200` response body `pong`.
If it doesn't, nothing is broken on GitHub's side that you can fix from
there; go check the server (see Troubleshooting below).

## Generate the token (the owner does this, not the builder)

On the server:

```bash
openssl rand -hex 24
```

Put the result in the server's `.env` as `DEPLOY_TOKEN=...`, and paste
the *same* value into the webhook's Secret field above. The token only
ever lives in those two places — never in git, never in a URL.

## Trigger it by hand

Same secret, a different header — no `?token=` in the URL (it would end
up in access logs, browser history and Referer headers):

```bash
curl -sS -H "X-Deploy-Token: <DEPLOY_TOKEN>" https://<HOST>/deploy.php
```

This path streams `git-deploy.sh`'s output back to you directly (it
skips the async 202-then-deploy dance GitHub needs, since a human
curling it can just wait).

## Rotate the token

1. Generate a new one (`openssl rand -hex 24`) and edit it into the
   server's `.env`.
2. GitHub → the webhook → **Edit** → paste the new value into Secret →
   Update webhook.

Done — nothing else references it.

## Where the log is

`storage/deploy.log`, appended (never truncated) on every run, both the
webhook and the manual path. Every entry is timestamped **UTC** — the
host clock, the app's own timezone, and the team are all on different
zones, so a bare timestamp with no zone marker is worse than useless
here. A deploy isn't "live" until its entry ends with:

```
✓ deploy <sha> done <UTC time>
```

A `200`/`202` from the webhook proves GitHub's delivery succeeded —
**not** that the deploy finished. Check the log line, and check that its
`<sha>` matches `git rev-parse origin/main` as of the merge.

`storage/deploy.lock` is the concurrency lock (see below) — it's just a
lock file, safe to delete manually only if you're certain nothing is
mid-deploy.

## The twice-rule, when `git-deploy.sh` itself changes

If a commit changes `git-deploy.sh`, the **first** push after it runs
the *old* copy — the shell interpreter already has the previous version
loaded by the time `git reset --hard` rewrites the file out from under
it. Push, then push again (or curl the manual path twice) whenever
`git-deploy.sh` is part of the diff.

## Concurrency

Two pushes close together must not run two deploys at once. `deploy.php`
takes a `flock()` on `storage/deploy.lock` before doing anything else; if
it's already held, the second request gets `409 deploy already running`
immediately (no queueing, no double-run).

## GitHub's 10-second rule

A deploy takes 20–90 seconds; GitHub marks a delivery **failed** past 10.
So the webhook path responds `202 accepted <sha>` immediately — via
LiteSpeed's `litespeed_finish_request()`, or the generic
`fastcgi_finish_request()`, or a manual flush as a last resort — and only
*then* runs `git-deploy.sh` and appends to the log. The `202` in GitHub's
Recent Deliveries confirms the trigger arrived; it does **not** confirm
the deploy finished — check the log for that.

## **Database changes are always manual — never automatic**

`git-deploy.sh` does **not**, and must never be made to, call
`/api/provision` or touch the database in any way. If a push includes a
change to `lib/Database.php`'s migrations, run this yourself, in this
order, exactly as documented in the main README:

**merge → deploy (auto) → `curl https://<HOST>/api/provision?token=<PROVISION_TOKEN>` (you, manually)**

This isn't a limitation of the automation — this project's migrations
happen to be idempotent (`CREATE TABLE IF NOT EXISTS`, additive
`ALTER TABLE ADD COLUMN`), so auto-running them would very likely be
safe. The separation is still kept on purpose: it's one deliberate
checkpoint between "code is live" and "schema changed," and a script
that starts trusting "it's probably safe" today is the same script that
silently runs an unsafe migration the day that stops being true.

## Security notes

- `deploy.php` reads `DEPLOY_TOKEN` by parsing `.env` itself, by hand —
  it never boots `config.php` or touches the database. If the rest of
  the app is broken, this endpoint still needs to work so you can pull
  the fix.
- `.htaccess` blocks `/.git/*` and `*.sh` from being served directly —
  necessary because the Git repo path is the doc root, so `.git/`
  physically lives inside the public web folder.
- The old `?token=` query-string auth was intentionally not carried
  forward for this endpoint. Anything in a URL ends up in access logs
  and browser history; a header does not.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| GitHub ping shows a non-200 / connection error | `DEPLOY_TOKEN` unset on the server (`503`), wrong Payload URL, or the host is blocking the request before it reaches PHP. |
| Ping is `200 pong` but a real push never deploys | Check the delivery's response body — `ignored refs/heads/<branch>` means it wasn't a push to `main`; `ignored event <type>` means it wasn't a `push`/`ping` event at all. |
| Every delivery shows `403` | Webhook Secret in GitHub doesn't match `DEPLOY_TOKEN` in `.env`, or you're on the manual path with the wrong header name (`X-Deploy-Token`, not `X-Hub-Signature-256`). |
| `409 deploy already running` and it never clears | A prior run died without releasing the lock (killed process, host restart mid-deploy). Confirm nothing is actually running, then delete `storage/deploy.lock`. |
| Deploy runs but the site still shows old code | You pushed a change to `git-deploy.sh` itself — see the twice-rule above. |

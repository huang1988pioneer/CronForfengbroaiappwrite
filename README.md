# CronForfengbroaiappwrite

GitHub Actions cron job for `huang1988pioneer/fengbroaiappwrite`.

It runs at minute 33 every hour, reads every Appwrite collection in the configured database, and records:

- collection metadata
- attribute count
- document count
- full document data

## GitHub Secrets

Add these secrets in `Settings -> Secrets and variables -> Actions`:

- `APPWRITE_ENDPOINT`
- `APPWRITE_PROJECT_ID`
- `APPWRITE_DATABASE_ID`
- `APPWRITE_API_KEY`

The workflow also supports the variable names used by `fengbroaiappwrite`:

- `NEXT_PUBLIC_APPWRITE_ENDPOINT`
- `NEXT_PUBLIC_APPWRITE_PROJECT_ID`
- `NEXT_PUBLIC_APPWRITE_DATABASE_ID`
- `NEXT_PUBLIC_APPWRITE_API_KEY`

Optional:

- `APPWRITE_HISTORY_RETENTION_DAYS`: number of days to keep under `data/history`, defaults to `30`.

## Output

- `data/latest/summary.json`: latest summary.
- `data/latest/collections/*.json`: latest collection snapshots.
- `data/history/<date>/<run-id>/summary.json`: summary for each run.
- `data/history/<date>/<run-id>/collections/*.json`: full collection snapshots for each run.

History is pruned automatically after each successful snapshot so only the most recent 30 days are kept.

## Run Locally

```bash
npm run snapshot
```

The GitHub Actions schedule is defined in `.github/workflows/appwrite-snapshot.yml`:

```yaml
cron: "33 * * * *"
```

## 鋒兄例行 Routine

`.github/workflows/routine-cronappwrite.yml` updates the Appwrite `routine` collection three times a day (Taiwan time, UTC+8):

| Taiwan time | UTC cron | Action |
|-------------|----------|--------|
| 上午 09:33 | `33 1 * * *` | add one random `鋒兄例行` document |
| 下午 15:33 | `33 7 * * *` | add one random `鋒兄例行` document |
| 晚上 21:33 | `33 13 * * *` | delete one random `鋒兄例行` document |

Each add writes `name=鋒兄例行`, a random `note` (token + timestamp, max 100 chars), and `lastdate1=now`.  
Each remove picks one matching `鋒兄例行` document at random.

Manual run:

```bash
ROUTINE_CRON_ACTION=add npm run routine:cron
ROUTINE_CRON_ACTION=remove npm run routine:cron
```

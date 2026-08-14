# CronForfengbroaiappwrite

GitHub Actions automation for the Appwrite database used by `huang1988pioneer/fengbroaiappwrite`.

## GitHub secrets

Configure these repository secrets under `Settings -> Secrets and variables -> Actions`:

- `APPWRITE_ENDPOINT`
- `APPWRITE_PROJECT_ID`
- `APPWRITE_DATABASE_ID`
- `APPWRITE_API_KEY`

The workflows also accept the corresponding `NEXT_PUBLIC_APPWRITE_*` secret names.

## Hourly database snapshots

`.github/workflows/appwrite-snapshot.yml` runs at minute 33 every hour. It saves collection metadata, attributes, document counts, and document data under `data/latest` and `data/history`. History retention defaults to 30 days and can be changed with `APPWRITE_HISTORY_RETENTION_DAYS`.

Local command:

```bash
npm run snapshot
```

## CronAppwrite collection

`.github/workflows/routine-cronappwrite.yml` maintains the standalone `CronAppwrite` collection. The collection contains these fields:

| Attribute | Type | Notes |
|-----------|------|-------|
| `period` | string(32) | `daily`, `morning`, `afternoon`, `evening`, or `manual` |
| `note` | string(255) | Random token and timestamp |
| `token` | string(64) | Random hexadecimal token |
| `source` | string(64) | Defaults to `CronForfengbroaiappwrite` |

### Automated schedule

| Taiwan time | UTC cron | Action |
|--------------|----------|--------|
| Every day at 08:33 | `33 0 * * *` | Check whether this is the three-day full-clear date |
| Every day at 09:33 | `33 1 * * *` | Run the daily three-write cycle |

The daily cycle:

1. Adds one document immediately, waits 3 minutes, adds another, waits 3 minutes, and adds the third.
2. Counts the documents after all three additions.
3. When the count is greater than 33, deletes 3 random documents immediately, waits 3 minutes, deletes 3, waits 3 minutes, and deletes the final 3.

The full-clear schedule uses `2026-08-14` as the anchor date and clears every three days from that date. The workflow runs the check daily so the interval stays correct across month boundaries.

### Local and manual commands

```bash
npm run cronappwrite:ensure
APPWRITE_CRON_INTERVAL_MS=180000 npm run cronappwrite:cycle
ROUTINE_CRON_ACTION=add APPWRITE_CRON_PERIOD=manual npm run cronappwrite:cron
ROUTINE_CRON_ACTION=remove npm run cronappwrite:cron
CLEAR_FORCE=1 npm run cronappwrite:clear
```

Set `APPWRITE_CRON_INTERVAL_MS=0` when testing the cycle without waiting. The legacy helper below still targets the `routine` collection:

```bash
ROUTINE_CRON_ACTION=add npm run routine:cron
```

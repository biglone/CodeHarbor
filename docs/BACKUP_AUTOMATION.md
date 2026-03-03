# Config Backup Automation

This guide covers automatic backups for CodeHarbor config snapshots.

## 1) Manual Backup (Baseline)

```bash
./scripts/backup-config.sh
```

Custom output and retention:

```bash
./scripts/backup-config.sh --dir /var/backups/codeharbor --keep 30
```

## 2) systemd Timer Automation (Recommended on Linux)

Install a user-level timer that runs daily:

```bash
./scripts/install-backup-timer.sh
```

Custom schedule/output/retention:

```bash
./scripts/install-backup-timer.sh \
  --schedule "*-*-* 03:30:00" \
  --dir /var/backups/codeharbor \
  --keep 30
```

Dry-run (show generated unit files):

```bash
./scripts/install-backup-timer.sh --dry-run
```

Check timer list:

```bash
systemctl --user list-timers --all | grep codeharbor-config-backup
```

## 3) Cron Fallback

If `systemd --user` is not available, print a cron line:

```bash
./scripts/install-backup-timer.sh --print-cron
```

Add the output to crontab:

```bash
crontab -e
```

## 4) Restore Procedure

1. Validate snapshot before import:

```bash
codeharbor config import /path/to/config-snapshot.json --dry-run
```

2. Import snapshot:

```bash
codeharbor config import /path/to/config-snapshot.json
```

3. Restart service(s):

```bash
# Example (adjust to your deployment)
systemctl restart codeharbor.service
systemctl restart codeharbor-admin.service
```

## 5) Safety Notes

1. Keep snapshot files in private storage, since they may include sensitive fields (`MATRIX_ACCESS_TOKEN`, `ADMIN_TOKEN`).
2. Encrypt backup storage for off-host retention.
3. Test restore regularly in staging to verify snapshot integrity.

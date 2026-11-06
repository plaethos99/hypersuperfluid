---
name: systems-administration
description: Linux and Windows administration, networking, DNS, TLS, firewalls, disks, users and services. Load for machine, network or operating system problems.
---

# Systems administration

## Principles

- Look before changing: read the configuration and the logs, and back up a file before editing it (`cp file file.bak.$(date +%s)`).
- Validate a configuration before reloading: `nginx -t`, `apachectl configtest`, `sshd -t`, `visudo -c`.
- On a remote machine, never change SSH, firewall or network settings without a way back. Keep the existing session open and test from a second one, or schedule an automatic revert.
- Changes to users, permissions, boot, partitions or a firewall wait for a yes. So does anything on a machine other people use.

## Linux

| Question | Command |
|---|---|
| What is failing? | `systemctl --failed`, `journalctl -p err -b`, `journalctl -u NAME -n 100 --no-pager` |
| CPU and memory | `top`, `vmstat 1 5`, `free -h`, `ps aux --sort=-%mem \| head` |
| Disk | `df -h`, `df -i`, `du -xh --max-depth=1 / \| sort -h`, `lsblk` |
| Deleted files still held open | `lsof +L1` |
| Disk I/O | `iostat -xz 1 3`, `iotop -o` |
| Network | `ss -tulpn`, `ip addr`, `ip route` |
| Who has a file | `lsof FILE`, `fuser -v FILE` |
| Why denied | `ls -lZ`, `getfacl`, `namei -l PATH`, `ausearch -m avc -ts recent` |

A disk that is full by `df` but not by `du` is usually a deleted file held open by a process, or a mount hiding data underneath.

## Windows

Use PowerShell objects rather than parsing text.

| Question | Command |
|---|---|
| Services | `Get-Service \| Where-Object Status -eq Stopped`, `Get-CimInstance Win32_Service` |
| Events | `Get-WinEvent -LogName System -MaxEvents 50`, `Get-WinEvent -FilterHashtable @{LogName='Application'; Level=2}` |
| Processes | `Get-Process \| Sort-Object WS -Descending \| Select-Object -First 10` |
| Disk | `Get-Volume`, `Get-PSDrive -PSProvider FileSystem` |
| Network | `Get-NetTCPConnection -State Listen`, `Test-NetConnection HOST -Port 443`, `Resolve-DnsName NAME`, `Get-NetFirewallRule` |
| Permissions | `Get-Acl PATH \| Format-List`, `icacls PATH` |

Windows PowerShell 5.1 lacks `&&`, and its `Set-Content` defaults to the system code page, so pass `-Encoding utf8`.

## Networking

Work up the layers, and test the actual path each time:

1. Does the name resolve? `dig NAME`, `dig @8.8.8.8 NAME`, `Resolve-DnsName`. Compare a public resolver against the local one, because split DNS and stale caches are common.
2. Is there a route? `ip route get IP`, `traceroute`, `tracert`.
3. Is the port open? `nc -vz HOST PORT`, `Test-NetConnection`. A refusal means nothing is listening; a timeout usually means a firewall dropped it.
4. Does the service answer? `curl -v`, including status, headers and TLS.
5. Still stuck? Capture packets: `tcpdump -ni any host IP and port PORT`.

A service listening on `127.0.0.1` cannot be reached from elsewhere. Check the bound address in `ss -tulpn`. DNS changes wait on the TTL; check it before declaring a fix did not work.

## TLS

`openssl s_client -connect HOST:443 -servername NAME -showcerts` shows the chain actually served. Most failures are an expired certificate, a missing intermediate, a hostname mismatch, or a wrong system clock. `openssl x509 -in cert.pem -noout -dates -subject -ext subjectAltName` reads a certificate.

## Databases

- Back up first and test that the backup restores: an unverified backup is a hope.
- Wrap manual data changes in a transaction, and run the `SELECT` with the same `WHERE` first to see what it touches. Confirm the affected row count before committing.
- Find slow queries with `EXPLAIN ANALYZE`. Look for sequential scans over large tables and row estimates far from the actual counts.
- Schema changes on a large table can lock it. Check the engine's online options before running one on production.
- Check for blockers: `pg_stat_activity` on PostgreSQL, `SHOW PROCESSLIST` on MySQL.

## Pitfalls

- `chmod -R 777` is never the fix. Find the user and path that actually need access.
- Rebooting clears the evidence and may hide the cause. Capture logs first.
- Check the clock (`timedatectl`, `w32tm /query /status`) when TLS, Kerberos or tokens fail strangely.
- `rm -rf` with a variable path can delete everything if the variable is empty. Print the resolved path first.

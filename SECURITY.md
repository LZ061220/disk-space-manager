# Security Policy

## Supported versions

Only the newest GitHub Release is supported with security fixes.

## Reporting a vulnerability

Please do not publish a destructive cleanup bypass or local API vulnerability as a public issue. Use GitHub's private vulnerability reporting feature when it is enabled for this repository. Include the affected version, reproduction steps, and whether any files were moved or deleted.

The project never permanently deletes cleanup targets by design; supported cleanup actions send items to the Windows Recycle Bin. Nevertheless, treat any path-protection bypass as a high-priority security issue.

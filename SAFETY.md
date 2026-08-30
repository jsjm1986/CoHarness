# Safety

English | [中文](SAFETY.zh.md)

## Pre-release status

CoHarness is pre-release software and has not undergone a security audit. Do not treat it as a complete security boundary or assume that a production deployment is safe by default.

The project can execute model-generated commands and code, load third-party plugins, access files and processes made available to it, and optionally access external networks. Model mistakes, defects, misconfiguration, malicious input, or untrusted plugins may modify or delete files, disclose data or credentials, or damage the host.

## Sandbox and authorization limits

Sandboxing, approvals, Gateway authentication, project ACLs, and credential isolation reduce risk but do not guarantee isolation. They cannot protect resources that the deployment intentionally exposes, and a compromised plugin or host can invalidate assumptions made by higher layers. macOS deployments do not provide the Linux mount-namespace boundary.

Do not use CoHarness as the sole security control for untrusted workloads. Prefer a disposable VM or dedicated host, least-privilege accounts, restricted credentials, network egress controls, and tested backups.

## Responsible operation

- Review plugins, profiles, patches, commands, and model routes before enabling them.
- Keep WebFetch, plugin metadata, and Session-log upload disabled unless their endpoint, redaction, rate, audit, and rollback policy has been approved.
- Back up accessible files and databases; test restoration before migrations or release activation.
- Keep the Gateway behind TLS and its authentication flow; never expose an unauthenticated runtime port.
- Monitor logs, process trees, outbound requests, storage growth, and failed authorization decisions.

## No warranty

Use CoHarness at your own risk. The software is provided under the MIT License without warranty. To the maximum extent permitted by law, the authors and contributors are not responsible for damage, data loss, credential disclosure, or other harm arising from use of the project.

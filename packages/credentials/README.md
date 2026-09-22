# credentials/ — credential references

English | [中文](README.zh.md)

The credential capability family separates reference resolution from its provider:

| Package | Role | ctx key |
|---|---|---|
| [`credentials/`](credentials/README.md) | Credential-reference seam | `ctx.credentials` |
| [`credentials-local/`](credentials-local/README.md) | Environment and local-file provider | registers `ctx.credentials` |

Configuration carries references, not secret values. Consumers resolve those references at their operation boundary; the child READMEs own mutation, precedence, and storage semantics.

The subsystem reference — `CredentialRef`, per-operation resolution, UI-safe `CredentialInfo`, provider layers — is [docs/subsystems/credentials.md](../../docs/subsystems/credentials.md).


## Summary

The `credentials/` group lets configuration name secrets instead of embedding their values. Use `credentials/` to store, look up, and remove credentials, `credentials-local/` for private on-machine storage with per-run environment overrides, and `authorization/` when obtaining a credential requires asking a human. Rotated stored values apply to the next model request, while `DEEPSEEK_API_KEY=… dsh` takes precedence for that run. Configuration files contain only credential names; local secret values remain readable only by the same OS user.

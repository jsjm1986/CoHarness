---
kind: upgrade-guide
description: "Local document trash refuses invalid recovery manifests instead of discarding their records."
---

# Validate document recovery metadata

English | [中文](guide.zh.md)

## Change

Local document trash refuses unknown manifest versions, invalid or duplicate records, unsafe paths, and a missing manifest when hidden document files remain. Listing, trash, restore, purge, and retention cleanup fail with `DOCUMENT_TRASH_NOT_FOUND` before changing document files. Earlier builds could treat this metadata as empty or drop records before replacing the manifest. Valid version 1 manifests and ordinary empty stores require no conversion.

Restore refuses a concurrently occupied target with `DOCUMENT_RESTORE_CONFLICT` and retains the trash entry. Earlier builds could overwrite the concurrent file. A retry selects another free name.

Retention cleanup checks current file identity and expiry after writer admission. It skips entries restored, replaced or renewed during that wait instead of deleting their newer state or reporting a removal.

Trash refuses `409 DOCUMENT_TRASH_CONFLICT` when the original path contains an active replacement while its earlier entry remains in trash. Earlier HTTP routes could report successful deletion while the replacement stayed active. Both copies remain available after refusal.

## Migration

1. Back up the document root, including its private `.dsh-trash/` directory.
2. If trash operations report invalid recovery metadata, preserve every hidden file and restore a complete `.dsh-trash/manifest.json` backup belonging to that same root. Do not remove the manifest to reset the error.
3. Use the upgraded provider to list the trash and restore a known entry. Confirm its contents before resuming retention cleanup. If no complete backup exists, keep the directory intact for manual recovery; the provider does not reconstruct missing ownership or filename metadata.
4. Retry ordinary publication conflicts. If restore reports both a publication and rollback failure, preserve the remaining visible and hidden copies for recovery before retrying.
5. For `DOCUMENT_TRASH_CONFLICT`, inspect both documents and restore the earlier trash entry under another name before retrying the active deletion. Do not delete recovery metadata to bypass the conflict.

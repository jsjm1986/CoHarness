---
kind: upgrade-guide
description: "Managed file-upload callers must retain Session write authorization until receipt publication."
---

# File-upload Session permissions

English | [中文](guide.zh.md)

## Change

Binary `POST /api/session/uploadFileBinary` uploads previously passed browser authentication without the Session write check applied to the encoded Remote. Both entrypoints now enforce that check inside the upload service, including before cold Session lookup and before receipt publication. Private, read-only and withdrawn authorization returns the existing `collaboration-forbidden` error. The binary response retains its HTTP200 result envelope with `ok: false`.

Cancellation, service withdrawal or replacement of the receiving Agent prevents receipt publication. Active storage blocks automatic Agent idle disposal and permanent removal until settlement. Node HTTP inputs are closed during cancellation; custom iterable producers must settle their pending reads. Immutable bytes already committed can remain without a receipt.

## Migration

1. Rebuild `@deepseek-ai/dsh-client-file-upload` with its declared `@deepseek-ai/dsh-collaboration` dependency and deploy both definitions together. Managed Gateway compositions retain their required collaboration provider.
2. Send uploads only for Sessions the original account can write. Handle the existing structured refusal; retry with a fresh request after authorization recovers. Preserve independent local behavior by omitting managed collaboration only in an independent application.
3. Keep programmatic source reads cancellable. Confirm that an authorized upload returns a usable same-Session receipt, private and read-only uploads refuse, and unfinished uploads do not permit idle Agent disposal.

# Agent Note: Document operation drain

Status: implemented

English | [中文](2026-10-26-document-operation-drain.zh.md)

## Problem

The local document engine owns ordinary saves and directory mutations as well as resumable finalizers. Closing only scans and the upload manager leaves accepted filesystem work outside the owner's shutdown task. A chunk waiting for its next request-body byte also cannot observe cancellation by checking a signal only between reads. A file-close failure can replace the write failure that required cleanup.

A broker authorization lookup can remain pending after its current engine snapshot closes. Catalog delivery can likewise outlive the HTTP consumer if its queue has no awaited owner.

## Decision

Every engine operation holds an owner reference until its returned promise settles. Disposal closes admission synchronously, aborts body reads and scans, joins accepted operations and initialization, joins scans created during initialization, then stops finalizers. Repeated disposal returns the same task. Non-cancellable mutations finish while their owner remains available. Chunk cancellation interrupts a pending reader and awaits the source cancellation before releasing the reader. Independent operation and handle-close failures are retained together; failed chunks do not acknowledge progress.

The Gateway broker owns complete browser operations, including authorization lookups before an engine is selected. Shutdown rejects new operations, joins admitted requests, closes each HTTP scope, then disposes every engine. HTTP scopes retain accepted handlers and a per-owner catalog queue through route removal. A scope failure does not skip other engine cleanup, and shutdown preserves every cleanup failure. Deferred catalog callbacks retain their original request context; a later viewer does not supply delivery authority.

A successful exclusive create establishes ownership of an ordinary staging file. A failed create cannot authorize its deletion. An opened handle transfers to its caller only after metadata succeeds; a failed initial metadata read closes it. Ordinary and resumable readers and writers retain independent operation, source-cancellation and handle-close failures. Cleanup of an owned partial also preserves its failure, while an absent partial needs no removal.

An opened download transfers its stream and file handle to the caller. Its bytes need no subsequent engine operation, so the caller consumes or cancels the stream independently of engine disposal.

Move rollback restores the source link before deleting the destination. If that restoration fails, the destination remains available for recovery and the error retains both causes. A concurrent document occupying the source is never overwritten. Portable fault injection verifies both successful restoration and an occupied source; the Linux Loader scenario replaces the destination parent between source removal and directory validation.

This supplies the document owner's concrete shutdown sequence under the broader [runtime teardown decision](2026-08-27-bounded-runtime-work-and-teardown-fences.md). The [Gateway broker decision](../architecture/2026-10-15-gateway-local-document-broker.md) continues to own broker scopes and runtime independence. Neither decision is superseded.

## Alternatives considered

**Abort without joining.** A cancellation request does not prove that a source released its reader, a scan settled or a filesystem mutation finished.

**Wait for bodies without cancellation.** A sender can leave its next byte pending indefinitely, so accepted work cannot drain on owner shutdown.

**Close every returned download.** Ownership has transferred to the caller; the open file needs no live engine resource, and cancelling it would truncate an otherwise valid response.

**Key background work only by a host object.** A weak map can serialize work but does not identify who must await it before releasing the catalog transport.

## Consequences

Shutdown waits for accepted non-cancellable filesystem operations and cooperative stream cancellation. A source whose cancellation never settles can still delay shutdown. No timer substitutes for settlement. Source tests place initialization, scans, ordinary bodies, chunk bodies and directory mutations behind explicit barriers. The real Loader transcript verifies that provider disposal cancels both pending upload bodies, publishes no ordinary file and acknowledges no chunk bytes. File-handle fault cases retain both causes and leave durable chunk progress unchanged.

The shared Gateway/Runtime Loader fixture verifies catalog delivery after route removal and an admitted document read during plugin unload, using real signed principals and HTTP. Its unowned-consumer control fails at the catalog settlement assertion after the preceding copy-authorization cases succeed. Compiled broker probes retain two project actors independently and read the delivered catalog marker after disposal. These checks do not establish Linux OS-account isolation or complete the durable identity/catalog integration.

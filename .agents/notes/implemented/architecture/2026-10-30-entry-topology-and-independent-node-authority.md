# Agent Note: Entry topology and independent computer authority

Status: implemented

English | [中文](2026-10-30-entry-topology-and-independent-node-authority.zh.md)

## Problem

A browser can select a Runtime on another computer while retaining its original Gateway origin. Using that Runtime’s metadata to decide deployment scope lets a remote selection change its own routing authority. A display-only switch also leaves foreign URLs and cached mutation targets usable.

## Decision

Organization policy chooses one aggregation entry. Every browser reads policy from its original Gateway before forwarding; resource catalogs filter entry scope before paging and routing checks resolved targets. Runtime identities and computer permissions remain separate from this deployment policy. Single-computer mode changes aggregation and presentation without changing local multi-user or multi-Runtime storage. Document directory bindings serialize logical owner kind and id, so another Runtime for the same computer-local scope can reopen the existing private store. Runtime UUIDs and generations remain execution authorization fields.

Account revalidation withdraws aggregation and account-scoped entry details until fresh verification. The last verified origin mode still determines whether location labels are visible, so multiple personal document locations keep their distinguishing names during a metadata refresh. This presentation fact grants no computer access and does not retain the previous account’s catalogs.

Computer attachment has pending, managed and detached states. Ticket issuance retains local authority. Activation and managed detachment serialize with process-generation admission and require confirmed stopped Runtime records. Detachment pauses managed service admission, refuses active streams and invalidates credentials and lease generations. A fresh independent generation uses local authority; no old managed generation becomes independent by relabeling it.

Database restore preserves destination topology and enrollment authority, advances connection epochs and excludes private connection-control files from application-data roots. Enrollment issuer UUIDs remain historical facts without requiring the issuer to exist in restored account data; retaining an unrelated live account would expand restored permissions. Legacy deployments retain managed lease validity until their original forwarding entry explicitly initializes the policy. New organizations default to single-computer mode.

## Alternatives considered

- Computer-count heuristics cannot distinguish disabled aggregation from an unavailable node or direct secondary access.
- Clearing remote selections on a mode change can submit an unsaved form against another computer. Captured targets stay fixed and become unavailable.
- Automatic detachment on lease expiry treats an unknown process as stopped. Confirmed termination remains necessary.
- Restoring topology from a data snapshot can resurrect revoked enrollment or silently replace the primary.

## Consequences

Mode transitions require explicit detachment, and changing the primary requires a stopped attachment cycle. The primary’s local work remains independent. Browser tabs exchange revision invalidation without selection or draft synchronization. Metadata reads remain lazy and do not start other Runtimes. Explicit Workspace or Session entry prepares the captured allocation through the account-scope API without navigation or selection cookies. Its cancellation signal and configured metadata deadline own preparation; an asynchronous selection change cannot redirect the later operation. Maintenance admits administrator stop requests addressed by owner or exact Runtime; generation checks and stale-restore fencing still apply. Deployment documentation owns the operating procedure and API details.

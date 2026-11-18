# Agent Note: Release order optional-peer and stack-member edges

Status: implemented

English | [中文](2026-11-16-release-order-optional-peer-edges.zh.md)

## Problem

`release:pack --family dsh` failed its topological publish order on the cycle `host-apiproxy → (install dep) → api-remotes → (peer) → client-connection → (peer) → host-apiproxy`. Two ordering rules were wrong for this graph. First, `peerDependenciesMeta.optional` peers were treated as hard publish constraints even though an optional peer may be absent at install, so it cannot demand a publish position. Second, peer-edge traversal could slot a package whose install-dep ancestor was still on the DFS stack — installing a dependency before its dependent that genuinely needs it — so a peer link closing over an unfinished install chain manufactured an unresolvable cycle.

## Decision

- `orderEdges` skips peer edges whose manifest marks the peer optional (`peerDependenciesMeta.<name>.optional`), matching npm semantics where optional peers carry no install guarantee.
- A peer traversal that reaches a package with an unfinished install-dependency ancestor on the DFS stack drops that peer edge and records the drop, instead of fabricating a cycle.

## Consequences

- The dsh family packs in a valid publish order (370 tarballs) and the packed-install smoke installs 380 tarballs with `dsh` reporting its release version.
- Real cycles that remain — install-dep loops, or peer loops whose members share no install ancestry — still fail loudly with the dropped-edge record for diagnosis.

## Alternatives considered

- Converting `client-connection`'s peer on `host-apiproxy` to a dependency — rejected: the bare import lives in `lib/index.js` and rule 6 already governs the edge; loosening a real constraint to satisfy an ordering bug hides it.
- Reordering only this instance by hand — rejected: the defect is in the traversal rule and would recur for every future package joining the same shape.

## Verification

- `families.spec.ts` gained the mixed optional-peer + install-ancestor cycle case; the suite runs 28/28.
- `pnpm run release:pack --family dsh` produced all 370 tarballs; the packed-install smoke installed 380 tarballs and `dsh --version` reported the product build.

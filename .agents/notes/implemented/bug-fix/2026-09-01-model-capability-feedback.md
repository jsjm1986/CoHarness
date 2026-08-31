# Agent Note: Model capability feedback in selection

Status: implemented

English | [中文](2026-09-01-model-capability-feedback.zh.md)

## Problem

The model picker received input-modality metadata, but an image-bearing conversation that selected a text-only model surfaced a generic operation failure. The user had to infer which models could continue the conversation and whether the failed selection changed anything.

## Decision

The picker uses each catalog row's `inputModalities` as the capability authority. A disclosed image-capable model is labelled `Supports images`, a disclosed text-only model is labelled `Text only`, and an omitted declaration remains unlabelled. The shared per-session directory formats the Host's image-history refusal into localized recovery copy that names the target model and recommends an image-capable model or a new text-only conversation. Other selection failures retain their code and diagnostic message. The change adds no session scan, wire field, persistence field, or database operation; a rejected selection still leaves the current model and image history unchanged.

## Alternatives considered

**Infer capability from a model name.** Rejected because provider-owned ids do not encode a reliable input contract.

**Scan the full client conversation to disable rows before selection.** Rejected because it duplicates the Host's authoritative image check and adds work proportional to the loaded history on every model-directory render.

**Introduce a new public RPC error code immediately.** Deferred because the existing Host message already identifies this case; the UI can provide clear recovery copy without widening the wire vocabulary.

## Consequences

Model choice is understandable before submission, and a rejected switch explains the next action without suggesting data loss or a provider outage. Providers that omit modality metadata remain conservative in presentation: the UI does not claim support it cannot verify. The shared directory keeps the popup and composer messages consistent while preserving the existing selection and persistence semantics.

## Verification

Browser-plugin tests cover capability labels and localized image-history refusal copy for both model-selection entries. Component tests cover labels and the updated action wording. The assembled `declared-reasoning` Web scenario records and replays the capability labels through the real model picker. Contract typecheck and contract lint pass; the full GUI and Web replay checks remain the owning release validation for the assembled bundle.

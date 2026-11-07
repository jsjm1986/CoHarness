# Agent Note: Native translation retains its owner until provider I/O

Status: implemented

English | [中文](2026-11-01-native-translation-admission.zh.md)

## Problem

Native translation binds a prepared Flash call to its selected provider. Model resource admission and credential resolution can wait after its input is logged. The native provider reads resolved Settings values; eligibility must use the same credential reference. Changing the native model configuration or credential reference during those waits must refuse that prepared call before provider I/O.

## Decision

Prepared streams accept a per-call guard outside model input. Asynchronous eligibility checks run after admission and before each physical provider request. A synchronous check follows all authorization awaits and verifies the retained owner immediately before adapter entry or I/O. Retries use the same guard, including effective resource cancellation. The translator retains both composition fields and the provider’s resolved Settings snapshot. Native translation aborts with `TRANSLATION_UNAVAILABLE` when that owner becomes ineligible; quiescent calls return their permits.

## Alternatives considered

**Check only before entering the model stream.** Queued admission and asynchronous adapter preparation outlast that check.

**Attach authorization callbacks or a Session id to model input.** Callbacks are process-local authorization. Native translation must remain an independent fragment; its Session id would enable unrelated native Session-log extensions.

## Consequences

The optional guard does not change persisted model requests, Session formats, adapter generation selection or ordinary streams. Each prepared call owns its guard; simultaneous consumers cannot share its authorization accidentally. The model-hidden `translation` purpose classifies usage independently of Session attachment. It conveys no user authority; the child SDK parser accepts that purpose while discarding child-supplied ownership claims. Adapters retain the requirement to invoke runtime dispatch authorization for every provider request.

## Verification

Controlled queues, authorization waits, credential resolution and retries exercise refusal and permit release. Native loopback tests cover Official model and credential-reference changes, credential removal, Account overrides and sign-out. Actual SDK fixtures compare translation results, durable request/result records, fragment isolation and released permits.

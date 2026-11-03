# Agent Note: Input ownership during New Session preparation

Status: implemented

English | [中文](2026-10-31-session-navigation-input-holds.zh.md)

## Problem

Creating a Session and opening its history are asynchronous. The existing conversation remains visible during preparation, so an enabled composer can accept a message for that existing Session after the user has requested a new one.

## Decision

The existing navigation owner holds the originating Session’s input until its preparation settles. The Session list publishes that hold within the browser tab. The composer displays the pending state without clearing its draft or stopping its task; the input facade checks the same live state before text, command, and attachment submission. Other Session panes and browser tabs remain independent.

A newer navigation supersedes the previous hold. Completion releases only the hold owned by its original cancellation signal, so a late completion cannot unlock a newer operation. Failed creation leaves the original conversation and draft usable. Staged Agent presets capture and exclude the originating Session, preserving the choice until a destination Session is selected even when intermediate navigation updates release the input hold.

## Alternatives considered

Disabling only the rendered Send button leaves callbacks that run before the next render able to submit to the old Session. Clearing the old conversation during preparation needlessly removes the user’s reading and task context.

## Consequences

The client navigation API accepts an optional originating Session and exposes explicit completion. It changes neither Runtime placement nor durable Session identities, files, or permissions. New Session creation retains its fresh-Agent semantics.

## Verification

Navigation ownership, failed and superseded creation, and text/command/attachment submission checks cover the hold lifetime. The real Web profile delays Session creation and captures the disabled originating composer, then verifies that reselecting history restores its draft and input.

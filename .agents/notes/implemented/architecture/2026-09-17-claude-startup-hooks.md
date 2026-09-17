# Agent Note: Await Claude Code SessionStart hooks

Status: implemented

English | [中文](2026-09-17-claude-startup-hooks.zh.md)

## Problem

Detached SessionStart hooks can inject guidance after the first model request. Awaiting Agent creation alone cannot guarantee that the request includes startup guidance.

## Decision

The Claude Code bridge awaits SessionStart on serial `agent/created`. Its process signal combines creation cancellation with bridge disposal. Cancelled runs cannot inject late context; hook failures remain logged and non-vetoing. Tracking the awaited run preserves process cleanup when the bridge unloads independently of the Agent.

## Alternatives considered

Keeping detached execution preserves the race. Polling for context in the caller cannot distinguish empty hook output from unfinished initialization. The existing serial creation event supplies the completion guarantee without caller-specific waiting.

## Consequences

Agent creation includes the SessionStart hook's execution time. Callers receive startup context before sending the first prompt; cancellation waits for hook process cleanup. Hook failures remain non-vetoing, so successful creation does not guarantee that a failing hook supplied context.

## Verification

Real shell-hook regressions cover first-request guidance, creation cancellation, bridge unload, and injection failure. A keyless product headless snapshot loads the real bridge, requires startup guidance in the model request, and checks its durable attribution. This change does not complete the remaining lifecycle consumers or the overall upstream upgrade.

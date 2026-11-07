# Agent Note: Desktop request authorization

Status: implemented

English | [中文](2026-10-31-desktop-request-authorization.zh.md)

## Problem

Desktop application routes can publish host metadata and launch local programs. Treating an absent authentication service as approval exposes these operations during startup and reload. A request admitted before asynchronous catalog or icon work can also outlive its authentication, qualification or plugin instance.

## Decision

The desktop plugin requires Connection before route registration. Each plugin activation owns a request-admission lifetime; unload invalidates that instance even when another instance appears. Requests verify current Connection and browser qualification after asynchronous reads, before publishing host data and before each physical primary, fallback or refreshed launch. Missing authentication or an invalidated handler receives 503; current authentication refusals retain their status. Already committed OS launches retain their independent lifetime.

The browser's [local Runtime selection rule](2026-10-04-open-in-app-local-runtime-gate.md) remains a separate requirement. This optional desktop capability stays outside the cloud Web bundle under the [selective synchronization decision](../architecture/2026-09-08-upstream-alpha2-selective-sync.md).

## Alternatives considered

**Require injection alone.** Removing a route cannot retract a handler already dispatched or suspended in asynchronous resolution.

**Capture one authorization result.** Browser qualification and plugin availability can change before a fallback or replacement launcher is reached.

**Terminate every launched application on unload.** Desktop applications intentionally outlive the Harness after the OS handoff; the admission rule governs new handoffs.

## Consequences

An absent provider never authorizes a desktop request. Controlled HTTP overlaps verify metadata withholding and zero new launch-adapter calls after withdrawal; a real Loader and Connection replay covers startup, replacement and unload with a synthetic browser cookie. These fixtures do not open a physical desktop application. Existing bounded discovery work may finish after withdrawal, but cannot publish its result or authorize another launch.

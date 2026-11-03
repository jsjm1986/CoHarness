# Agent Note: Admin project governance request ownership

Status: implemented

English | [中文](2026-10-31-admin-project-governance-ownership.zh.md)

## Problem

Admin model, quota and usage URL families contain both organization resources and project resources. Classifying every request by its URL prefix sends a remote project's model assignments, quota or reports to the primary computer, whose local project directory cannot resolve that project.

## Decision

Project-governance callers declare computer ownership when constructing requests. The request helper binds them to the computer in the document's Admin URL. Organization model configuration, account permissions, role/user quotas and aggregate reports retain organization ownership. Node enrollment and entry-owned deployment APIs retain their primary-entry routing.

The [deployment reference](../../../../gateway/docs/deployment-topology/README.md) owns the resource scopes. Existing Gateway authorization, topology restrictions and project lookup remain authoritative; the browser never substitutes another project or computer after a refusal.

## Alternatives considered

**Route every governance request to the selected computer.** Organization configuration and aggregate reports would depend on that computer's availability.

**Route every governance request to the primary.** Project configuration and policy-file projection belong to the project's computer.

**Infer ownership from the path alone.** Quota writes and contribution reads share paths across resource owners. Callers already know the selected subject.

## Consequences

Local Admin addresses retain local project behavior. Computer selection stays in each document URL, so another tab cannot redirect a project mutation. Metadata reads and governance edits do not start the project's Runtime. Existing role/user model defaults remain independent of project assignments.

# Agent Note: Mobile navigation and reading density

Status: implemented

English | [中文](2026-08-25-mobile-density-pass.zh.md)

## Problem

The compact conversation drawer used a near-full-width panel, large nested workspace cards, and desktop markdown spacing. The resulting phone view exposed too little transcript and made short responses feel oversized.

## Decision

Compact navigation uses a narrower drawer, a reduced group/list rhythm, and 44px minimum rows. Workspace and session hierarchy remains visible; only padding, card radius, title scale, and inter-row gaps change. Compact markdown uses the shared mobile body role, smaller heading roles, and shorter paragraph/list margins. Touch targets stay independent from visual text size.

## Consequences

The drawer leaves a visible conversation strip behind the scrim and more history fits before scrolling. A short response now reads as a compact document rather than a desktop document scaled into a phone. Desktop layout and data operations are unchanged.

## Alternatives considered

**Keep desktop spacing on compact viewports.** This preserves one set of visual values but leaves too little conversation visible on a phone, so compact spacing has its own documented values.

**Make the compact drawer full width.** This maximizes the drawer canvas but hides the conversation context behind the scrim, so the drawer remains narrower and leaves a visible strip.

## Verification

Workspace, layout, sidebar, and primitive style suites pass. The assembled compact visual audit passes at 320/375/390px and screenshots were reviewed after the density changes.

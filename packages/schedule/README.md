# schedule/ — Session-local reminders

English | [中文](README.zh.md)

The Schedule family owns reminders whose durable state lives in the original Session log. A process-local owner waits only while that Session has a live root Agent; cold Sessions resume overdue work when they become live again and never imply an external notification channel.

| Package | Role | ctx key |
|---|---|---|
| `schedule/` | Versioned Schedule events and fold, model-facing create/list/delete tools, and a live root-Agent timer owner | — |

The package deliberately exposes no public Schedule service or mutable database. Tools and runtime append to the Session stream; due work enters the same conversation through the Agent's ordinary follow-up queue.

See [Session-local Schedule](../../docs/subsystems/schedule.md) for the durable record, transition, view, and delivery contracts.


## Summary

The schedule group lets an agent create, list, and cancel reminders for the current conversation. Reminders can run after a delay, at an absolute time, or on a fixed interval; when due, they arrive as ordinary messages in that conversation. They survive restarts, but never leave the session or send email, SMS, or push notifications. The group's package provides reminder management and delivery. Optional browser packages show the current reminder catalog and mark conversations with known active reminders; those indicators reflect cached state and may lag the running session.

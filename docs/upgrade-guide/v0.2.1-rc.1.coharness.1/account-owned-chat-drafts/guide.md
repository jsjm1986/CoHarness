---
kind: upgrade-guide
description: "Gateway chat drafts require account ownership and do not restore unowned browser records."
---

# Gateway chat drafts belong to the verified account

English | [中文](guide.zh.md)

## Change

Gateway chat drafts use account, runtime, and Session ownership instead of only a Session id. Existing `dsh.conversation.chat.<Session>` browser records have no record of the writer's account and are not restored into Gateway accounts. They remain in browser storage. Independent Hosts explicitly declaring that Gateway authority is not required retain their local keys.

Each tab retains a session-storage copy of its owned record and restores it before the shared durable copy. New tabs seed that copy from the existing owned record; reloading one tab preserves its text independently of other tabs. Space navigation retains images, document references, and input that cannot be restored safely in the source tab, offering the target in a new tab. Custom `SessionInputResolver` implementations must provide `hasUnsavedDrafts()` for all input they retain.

Custom `IConversation` implementations must also provide `canAttachDocument(sessionId)`. Document managers call it before copying to a captured conversation and recheck at acceptance; authorization plugins may refuse through `conversation/document-admission` by returning `deny`. Explicit document copies remain available without a conversation. Gateway directory consumers may resolve saved Runtime IDs with `ids`; the existing cursor and byte limits still apply.

Custom frame presenters supply `compact` to `shell.mobile.header.context`. `ComputerControl` reads Session selectors so its label follows the selected conversation’s Runtime; a missing location never falls back to another Runtime. `ComputerBadge` without details or actions is passive text. Consumers needing a menu supply explicit details or actions; environment navigation belongs in the space selector.

## Migration

1. Before upgrading, copy or send your own unsent drafts from each affected Gateway browser profile. Shared Session access does not establish ownership of another member's unsent input.
2. After upgrading, sign in to the same Gateway account, open the corresponding Session, and paste any saved text you still need. New records use the `dsh.conversation.chat.scoped.v1.` prefix in that origin's local storage. No Session log or database migration is required.
3. Reload the Session to confirm your draft returns. If you share the browser with another account, confirm that account opens with its own draft. See the [conversation persistence reference](../../../../packages/client/ui-conversation/README.md).

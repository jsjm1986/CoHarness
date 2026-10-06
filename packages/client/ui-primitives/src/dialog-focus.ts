/** Shared keyboard and focus-loop behavior for in-page dialogs. */

/** Modal surfaces a document-level keyboard dispatcher must not route around. */
export const modalSelector = '[role="dialog"][aria-modal="true"], [role="menu"]'

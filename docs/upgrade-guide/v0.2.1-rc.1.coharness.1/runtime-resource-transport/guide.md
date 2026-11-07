---
kind: upgrade-guide
description: "Configure managed Runtime resource deadlines for remote database round trips."
---

# Configure Runtime resource transport

English | [中文](guide.zh.md)

`HGW_RUNTIME_REQUEST_TIMEOUT_MS` and `HGW_RUNTIME_CLEANUP_TIMEOUT_MS` configure each node's managed resource-accounting plugin. Defaults remain 5000 and 30000 milliseconds. Cleanup must exceed one request; increasing either value does not grant resources or release uncertain occupation.

`HGW_RUNTIME_BROWSER_READY_TIMEOUT_MS` and `HGW_RUNTIME_BROWSER_STREAM_TIMEOUT_MS` project the existing connection plugin’s browser handshake deadlines for every Runtime on that node. Defaults remain 15000 and 3000 milliseconds. Increase them for a slow managed connection; the primary computer retains its own settings. These values do not relax authentication or change the browser’s selected allocation.

Connections opened within one page inherit that page’s recovery settings. For unified-page switching, configure the entry computer’s browser deadlines to cover the slowest connected computer the page will use, as well as configuring that computer’s own direct entry.

`HGW_RUNTIME_BROWSER_RPC_TIMEOUT_MS` configures the connection plugin’s bounded unary RPC deadline, with its existing 30000-millisecond default. A longer handshake deadline alone cannot extend an individual Host query; configure both when measured round trips require it. User-paced calls and streams retain their existing lifetime.

Existing configuration records need no rewrite. For a node with slow database round trips, save measured deadlines in its current-node configuration and apply them through the existing maintenance and independent-worker flow. New Runtime generations receive the applied values; existing generations retain their loaded plugin settings until restarted. See the [node configuration reference](../../../../gateway/deploy/node-configuration/README.md).

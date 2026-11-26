# apps/web browser e2e

English | [中文](README.zh.md)

These tests drive the Web application over HTTP with Chromium, WebKit, or Firefox. [`scaffold.ts`](scaffold.ts) and the [browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md) document fixture composition, snapshot modes, and built-host scenarios.

Register each browser scenario in [the Web test policy](../../../scripts/web-test-policy.json) so CI can select its owning group. `pnpm exec vitest run scripts/web-test-policy.spec.ts` checks that the scenario inventory is complete.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate,
because they read Host services directly: `ctx.apiProxy`, the Host
`SessionStore`, `ctx.sessionProjectionCache`. Driving a browser at runtime does
not make a file part of the Client program — the two faces merge cordis
`Context` under the same keys with different services, so one program cannot see
both. Moving these files into the Client aggregate makes every Host-service
access fail to compile.

## Do not import `@deepseek-ai/dsh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript
project, and every project it references, into the **Host build graph**. That has
bitten this lane once already: four Client consumer packages reference
`api/remotes`' Client face, which cannot compile until Host tsdown has generated
`@deepseek-ai/dsh-goal/remote`, so the Host build phase ended up waiting on an
artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here
instead, next to the commented-out import that names the source module. A drift
then surfaces as a missed selector or a stale mirrored value — a loud failure,
never a silent pass.

Two kinds of Client import stand. `assembled-boot.ts` drives the shell itself, so
it imports `AppWebEntry` from `@deepseek-ai/dsh-client-web` and the boot-manifest
type from `@deepseek-ai/dsh-client-modules/client`: booting the real shell is what
that harness is for, and both packages are already in the Host graph. Separately,
the chat scenarios import `conversationContextKey` from
`@deepseek-ai/dsh-client-runtime/client` because `client/runtime` is reachable
through the unsplit `directory-picker` packages and pulls nothing further in.
That reachability is incidental, not a guarantee — if it ever leaves the graph,
mirror the helper like the rest.

Nothing mechanically enforces this rule; keep it in review.

## Runtime scope and timed-question regressions

Run `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/project-activity.e2e.ts apps/web/tests/timed-question-claim.e2e.ts` after building the affected Client bundles and Web frontend. `DSH_SNAPSHOT=refresh` rewrites their UI goldens; ordinary execution compares them without an API key.

The activity scenario changes a shared scope cookie in a second browser tab and verifies that the original page still requests its pinned project before revealing a real seeded conversation. Its UTC browser calendar is fixed while network and UI timers remain live, and its ARIA expectation lives under [expected/project-activity](expected/project-activity/ui.expected.md). Only the external account Gateway endpoints are substituted. The timed-question scenario copies the shipped standard preset into an isolated directory, selects the supported timed ask-user configuration, and delays its real browser claim request until the actual Host wait expires. A replayed model tool call, the timed tool, Session projection, late-answer Remote call and subsequent model turn all run through the assembled application.

The multi-computer latency replay can use a dedicated Chromium on another computer through a loopback SSH tunnel. `DSH_BROWSER_CDP_ENDPOINT` selects its local HTTP debugging endpoint and `DSH_BROWSER_FIXTURE_PORT` fixes the loopback entry port forwarded to that browser. Keep the two Hosts and the test account isolated. `DSH_BROWSER_LATENCY_RECEIPT` writes timings only, with a separate partial file during sampling. The send interval starts at Enter and ends with the first verified durable receipt for the same account, Runtime, Session and request. If the first response is uncertain, it includes the status read. Rendering is timed separately.

`frontend-responsiveness.e2e.ts` opens a generated search result through the real Trajectory inspector, expands and collapses its complete JSON array, and checks directory expansion across a file-tree refresh. The scenario uses synthetic data and no model call.

Its list-arrival scenarios hold the real Host's first Session and Workspace baseline responses independently, then compare loading, verified-empty, and failed-list ARIA output. One transport failure per list verifies explicit Retry against the real Host; arrived rows stay visible while the other baseline is held. Populated Workspace and flat lists at 1280 and 390 pixels check row and viewport geometry, scrolling, focus, pointer menus, and the notice footer across a failed generation and explicit Retry. The connection and routes belong to the private scaffold. Every barrier is released before route and scaffold teardown.

`startup-rpc-budget.e2e.ts` checks that the cold boot shares one Workspace baseline and retains the settings mirror's two reads. It waits for the interactive picker, the connection-reset settings read, and completed startup RPCs before checking request counts.

## Mobile acceptance

`responsive-shell.e2e.ts` covers 23 CSS viewport sizes: 320–820-pixel portrait widths, 568–932-pixel short landscape widths, and 767/768/769 plus 1023/1024 around the shell breakpoints. Every size uses touch input and checks navigation, the Settings overlay, and the Plugins page. Device profiles add DPR, coarse-pointer/no-hover checks, rotation, light/dark themes, reduced motion, and increased text spacing. Internal scroll regions and forms require their focused scenarios; page-level overflow alone cannot detect clipped content.

Separate shell scenarios shrink the reported visual viewport in all four width modes for a new conversation and a conversation with recorded history, verify the frame height and draft reachability, and restore the full height. This drives the shipped resize listener without running an operating-system keyboard; the explicit-device scenario owns native keyboard and gesture acceptance.

After `pnpm run build`, run `pnpm run test:web:built apps/web/tests/responsive-shell.e2e.ts` for Chromium and repeat with `DSH_RESPONSIVE_BROWSER=webkit` for WebKit. Install the latter once with `pnpm --dir apps/web exec playwright install webkit`. `DSH_MOBILE_SCREENSHOTS` optionally writes 320/390/844-pixel Settings and Plugins screenshots to the given directory for visual review. `boot-page-accessibility.e2e.ts` checks long plugin failures, short-screen scrolling, reduced motion, and forced colors before the shell loads.

`settings-compact.e2e.ts` accepts the same browser selector. It rotates an open provider form while preserving its draft and focus, doubles rendered text sizes, and edits, saves, and resets the real Terminal plugin at 320 and 390 pixels. Doubling computed font sizes is a synthetic text stress test, not browser zoom. `access-confirmation.e2e.ts` also accepts the browser selector and verifies the mobile settings sheet's confirmation layer, click targets, and focus restoration after reducing the reported visual viewport.

The matrix follows [Playwright emulation](https://playwright.dev/docs/emulation), its [maintained device descriptors](https://github.com/microsoft/playwright/blob/main/packages/isomorphic/deviceDescriptorsSource.json), and W3C's [320-CSS-pixel reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html) and [text-spacing](https://www.w3.org/WAI/WCAG22/Understanding/text-spacing.html) checks. Add each new layout breakpoint's adjacent widths and each new user flow's loading, failure, long-content, focused-input, and overlay states to the owning scenario.

Browser emulation is not physical-device acceptance. Before a mobile release, repeat critical flows on current iOS Safari and Android Chrome with the operating-system keyboard, address-bar expansion/collapse, display/text scaling, rotation while editing, and notched-screen safe areas. Check that focused fields and primary actions stay reachable and drafts survive resizing. WebKit is Playwright's build, not installed Safari; synthetic visual-viewport or layout-height changes do not reproduce an operating-system keyboard. Device/browser versions and these manual results belong in the release evidence.

`admin-layout.e2e.ts` serves the built Admin application through an authenticated Gateway with private SQLite data. Touch contexts cover phone widths from 320 to 540 pixels, short landscape screens, 767–769 pixels, and both sides of the Admin sidebar's 840-pixel breakpoint. Representative light, dark, long project name, and increased text-spacing cases check page overflow, form labels and descriptions, dialog actions, touch targets, navigation, and horizontally scrolled table actions. A reduced layout height checks form space; browser emulation does not exercise an operating-system keyboard. Build Admin before running this file; `DSH_SNAPSHOT=refresh` records its accessible form and failed-query transcripts. `DSH_ADMIN_LAYOUT_SCREENSHOTS` optionally selects an output directory for user-form and long-project screenshots at 390- and 844-pixel widths.

The Admin layout suite checks that the model catalog downloads its script after the Users list renders, reads model data when opened, and offers reload if the script is unavailable. It holds the catalog request to check that the secondary script downloads after the catalog renders. The model tabs reuse the prepared script. A separate case holds that script while opening both tabs. It verifies that their data requests can finish and that the resolved digest settings appear in the first governance render.

Review every route and mounted plugin state separately, including loading, empty, failure, long content, editing and overlays. A browser-engine selector alone is not mobile coverage. Confirm the layout viewport still matches the requested width, then inspect local scroll regions and reachable actions. Review screenshots for balanced spacing, vertical alignment, readable title/action grouping and selected-state hierarchy; passing overflow assertions does not establish visual quality.

`admin-responsive-pages.e2e.ts` visits 19 distinct Admin routes, including organization and local recovery, plus a separate computer-context scenario. Each reached state records its checker and applicable checks in `<engine>-states.jsonl`; `DSH_ADMIN_VIEWPORTS` selects from 18 phone, landscape, tablet and desktop dimensions. Emulated pages use the shared geometry, target-size and hit checks; physical Android reports its narrower native checks separately. `DSH_ADMIN_LAYOUT_SCREENSHOTS` captures the actual viewport before and after control inspection at the configured screenshot widths.

`admin-dialog-states.e2e.ts` opens forms and confirmations through authenticated Admin pages. It exercises retained filter drafts, loading, empty results, refused reads and writes, account and computer review, changed review versions, release acknowledgement and local data-binding submission. Each test uses isolated HTTP outcomes and checks request fields where relevant; synthetic recovery confirmations do not alter real organization or retained Runtime data. `DSH_FEATURE_MATRIX=1` repeats each reached state across the selected Admin dimensions, with `DSH_RESPONSIVE_BROWSER` choosing one engine per run.

`responsive-browser.ts` provides 17 shared phone, landscape and breakpoint dimensions and selects Chromium, WebKit or Firefox through `DSH_RESPONSIVE_BROWSER`. Its 872 × 230 landscape case includes the space occupied by real Android browser controls. `DSH_RESPONSIVE_VIEWPORTS` selects a comma-separated list of declared names for incremental replay; omit it for the complete matrix. Controls must fit their clipping ancestors after scrolling, not only the page viewport. The control audit includes an interactive root as well as its descendants; a disclosure used as the inspection surface still receives reachability checks. Run related files serially against one completed build; concurrent builds can replace modules during a scenario. Admin and Gateway browser tests belong to `gateway/tsconfig.browser.json`, while ordinary Host-driven Web tests belong to the root Host compiler face.

The v9.2 control audit also checks 24px pointer targets, 44px coarse-pointer targets and actual hit testing without activating controls. Associated checkbox/radio labels count by their effective hit region. Targets within visible prose retain the [inline exception](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum), including inline reference buttons; standalone actions and toolbars do not qualify. Disabled controls and noninteractive reading surfaces retain geometry checks. Blocked targets try up to 32 positions in user-scrollable ancestors while retaining geometry, size and hit checks; exhausting the limit reports an incomplete probe. Nine sampled points, open Shadow DOM and rectangular iframe transforms detect common occlusion failures; they do not establish pixel-complete or screen-reader acceptance. Receipts identify the checker version and checks; older geometry receipts do not inherit the added guarantees.

`memory-responsive.e2e.ts` verifies cancellation and collapse/reopen of timeline deletion, then checks that Plugins and Memory titles follow navigation while the original conversation draft is retained. Real screenshot pixels measure enabled Kind and Content boundaries and Switch boundaries and thumb positions against adjacent colors in both themes; disabled switches are recorded separately. A deliberately weakened real editor border verifies that the boundary check rejects insufficient contrast.

`text-contrast.ts` measures rendered text in both themes and captures the reached state. Screenshots wait for active finite CSS transitions across the page; paused or delayed animations retain their lifecycle, so capturing a toast does not dismiss it.

The shared launcher defaults Firefox's temporary `network.proxy.type` preference to `0` so local HTTP fixtures bypass system proxies. Caller launch options and preferences remain available; the launcher does not change the host's proxy settings.

`settings-pages-responsive.e2e.ts` reaches each Settings section, exposed plugin configuration, preference menu, model form, and shortcut editor state. `DSH_MOBILE_SCREENSHOTS` saves every viewport. Set `DSH_FEATURE_MATRIX=1` to enable the per-state matrix in existing conversation, question, approval, attachment, preset, workflow, and workspace scenarios; ordinary replay retains its mouse-mode goldens. `DSH_FEATURE_LAYOUT_SCREENSHOTS` stores screenshots and accessible trees; scrolled workflow states also retain a `-start.png` view of their content before restoring the scroll positions. `DSH_FEATURE_COVERAGE_OUTPUT` stores a receipt for each state and dimension. Failed assertions remain failures in both lanes.

`experimental-panels-responsive.e2e.ts` creates real Team members through the subagent service and opens a member from the roster while another remains running. Its worktree scenario selects a real Git branch, holds named creation phases, cancels, retries a missing branch, continues without a worktree, and verifies a completed checkout without changing the original dirty file.

`plugin-market-responsive.e2e.ts` launches the built Web host and uses a local registry to exercise installation, activation, and navigation to the installed plugin. A file written by the plugin confirms activation and is removed when the host shuts down. The pnpm wrapper accepts only the temporary profile, with private configuration, store, and cache. Existing fixture bundles are installed as links.

The reference and skill scenarios also use this matrix. `reference-composer.e2e.ts` and `reference-drill.e2e.ts` cover grouped suggestions, filtering, directory navigation, picked inline references and sent references with recall. The skill policy, user invocation and tool-row scenarios cover candidate lists, injected instructions, recorded output and source previews. Preview loading holds a real Host response; unavailable source uses a removed fixture-owned skill, and failed source substitutes only that read's transport response.

Skill instruction checks scroll the real inner reading region and its user-scrollable ancestors to recorded body text and final lines. Each rendered line must fit all clipping ancestors and pass pointer hit checks; a reading region taller than the viewport need not fit in full. Captures distinguish the body, final lines and content start.

Goal, Plan, Schedule, Activity and Progress scenarios use the shared matrix for their reachable loading, empty, refused, retained-draft and expanded-content states. Goal tests use the real goal service with its automatic round driver disabled and open blocked reasons by touch. Plan approval and change requests delay or refuse `/api/respond`, then retry. The timed-question scenario similarly checks pending submission, retained choice and exactly one admitted answer after retrying `/api/userQuestions/answer`. Plan's accepted-RPC-reply/local-withdrawal failure branch is not reachable through the shipped waterfall flow; a component test covers that branch.

`schedule-management-states.e2e.ts` uses real Hosts for timing modes, invalid drafts, Session-link availability and Schedule tool calls. Its two-computer fixture uses the managed account directory and prepared-session creation; account discovery uses the fixture router. Explicit environment refresh observes computer availability, while a refused creation retains its selected Runtime and input draft for retry. Sidebar task previews use pointer hover, so those checks do not establish touch access to hover content.

`host-release-responsive.e2e.ts` changes release identifiers in plugin-manifest SSE responses and checks postponing notices, retained drafts, repeated notifications and reload navigation. This protocol fixture does not install a new Host release. `conversation-statistics-responsive.e2e.ts` opens per-turn token and timing details and the context composition chart from replayed Session events, including missing, empty and restored values. Both use the shared feature matrix.

The documentation suite reads every published route from `website/docs.ts`. `pnpm run docs:test:responsive` builds the site and checks each route and rendered diagram at 18 dimensions with the shared geometry, target-size, and hit-test checker. Raw Markdown links, both color schemes, and doubled content text with enlarged spacing are checked per route at 320 px. Separate cases exercise navigation, outline links, search, theme persistence, Markdown copy and failure feedback, code copy, and diagram controls in both locales at all 18 dimensions; these shared cases do not replace route checks. Unknown URLs in both locales separately check the rendered 404 message, omitted Markdown actions, search, navigation, theme switching, and return to the locale home at all 18 dimensions; the recorded preview HTTP status does not establish production hosting behavior. Clipboard adapters verify requested bytes without writing the host clipboard. `DSH_RESPONSIVE_BROWSER` selects Chromium, WebKit, or Firefox. `DSH_DOCS_RESPONSIVE_ARTIFACTS` stores plans, state receipts with checker versions and pointer capabilities, case outcomes, and viewport screenshots. Screenshots default to widths 320, 390, 844, and 1024; `DSH_DOCS_SCREENSHOT_WIDTHS` selects other declared widths. `DSH_DOCS_ROUTES` accepts exact manifest routes including `.md`, and `DSH_DOCS_VIEWPORTS` accepts declared widths for focused runs. Missing receipts remain unexecuted.

For an explicitly selected Android test phone, set `DSH_ANDROID_SERIAL` and `DSH_ADMIN_ANDROID_CDP_ENDPOINT` to its loopback CDP forward and run `android-real-device.e2e.ts`. Add `DSH_ANDROID_ARTIFACTS` for native device screenshots and measured viewport receipts. `DSH_ANDROID_ROOT=1` explicitly permits root commands for rotation settings on test devices whose shell cannot change them. Use `DSH_ANDROID_SYSTEM_MATRIX=1` for five display densities and three OS font settings; these settings do not by themselves prove that the browser enlarged page text. `DSH_ANDROID_IME` selects an already installed keyboard for the test. The explicitly selected `DSH_ANDROID_OCCLUDING_IME=1` scenario verifies recovery after dismissing an input method that occupies nearly the entire landscape screen. Before changing the device, the scenario requires readable settings that it can restore. It closes its own page and reverse mapping, restores prior display density, font, keyboard and rotation settings, and verifies them by reading them back. Android uses a new page in the browser's native context: CDP-created contexts can have zero-sized, non-native views. Native `screencap` captures the keyboard and browser chrome. While the native keyboard is visible, acceptance saves only that capture and checks the visual viewport before and afterward; CDP page capture can repaint a different layout viewport. Each fixture owns private application data and a fresh local port.

For the [startup isolation scenario](plugin-startup-isolation.e2e.ts) on a short Android landscape viewport, set `DSH_ANDROID_IME_SEND_POINT=x,y` to the Send key's physical screen coordinates from a native screenshot. The test taps that key with the software keyboard open and waits for the turn to settle. Leave the variable unset to exercise the page's Send button after keyboard dismissal.

`DSH_ANDROID_WORKBENCH=1` creates two private Workspaces and opens their conversations together. It checks complete input visibility before preparatory scrolling on initial display, with the native landscape keyboard, and after keyboard dismissal. Send reachability is checked separately. The scenario measures the short-screen toolbar's touch targets and alignment, then verifies both drafts after portrait and landscape rotation.

`DSH_ANDROID_FEATURE_PAGES=1` also exercises Memory creation, editing and deletion, a real terminal command, and embedded browser navigation in portrait and landscape. The embedded page uses a second fixture-owned server and reverse mapping. `DSH_ANDROID_DOCUMENTS=1` adds real PDF and text storage, portrait and landscape previews, second-page PDF reading through native scroll gestures, and the folder form. PDF acceptance checks rendered text and nonempty canvas pixels when native viewing is unavailable. Document-manager Chromium runs use the full `chromium` channel and exercise both built-in and application readers. Navigation inventory alone does not cover right-sidebar plugins; each feature needs its own native interaction and viewport evidence.

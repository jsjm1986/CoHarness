import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
const binScript = fileURLToPath(new URL('./fixtures/dsh-badge/snapshot.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/dsh-badge/cordis.yml', import.meta.url))
const defaultConfigPath = fileURLToPath(new URL('./fixtures/dsh-badge/default.cordis.yml', import.meta.url))
const tsconfigPath = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const badgeAssetsPath = fileURLToPath(new URL('../../../packages/skill/skill-badge/assets/', import.meta.url))

describe('dsh badge assembled snapshot', () => {
  it('advertises and loads the opt-in bundled skill through the shipped app', async () => {
    const disabled = await runLoaderSmoke({
      label: 'disabled dsh badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-dsh-badge-disabled-',
      binScript,
      libBinScript: binScript,
      configPath: defaultConfigPath,
      tsconfigPath,
    })
    const enabled = await runLoaderSmoke({
      label: 'dsh badge skill snapshot',
      tempDirPrefix: 'headless-snapshot-dsh-badge-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
    })
    const disabledSnapshot = JSON.parse(disabled.stdout) as unknown
    const enabledSnapshot = JSON.parse(
      enabled.stdout.replaceAll(badgeAssetsPath, '{{badgeAssetsPath}}'),
    ) as unknown

    expect(disabled.stderr).toBe('')
    expect(enabled.stderr).toBe('')
    expect(disabledSnapshot).toMatchInlineSnapshot(`
      {
        "catalog": null,
        "result": {
          "content": [
            {
              "text": "Error: skill "coharness-badge" is unknown or no longer available",
              "type": "text",
            },
          ],
          "error": {
            "message": "skill "coharness-badge" is unknown or no longer available",
          },
          "isError": true,
        },
        "summary": null,
      }
    `)
    expect(enabledSnapshot).toMatchInlineSnapshot(`
      {
        "catalog": [
          {
            "text": "<system-reminder>
      A skill is a reusable set of task-specific instructions. The following skills are available in this session:

      <available_skills>
      - \`coharness-badge\`: Add the official “powered by CoHarness” badge to documents, pull requests, merge requests, and other content produced with CoHarness. Use whenever creating a pull request or merge request. Also use when the user asks for a CoHarness badge, powered-by-CoHarness attribution, or a reusable CoHarness badge asset or snippet.
      </available_skills>

      If the user names a skill, or the task clearly matches a skill's description, call the \`skill\` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.
      A user may also invoke a skill directly; its <skill_content> block then appears in this conversation. Follow it, and do not call the \`skill\` tool again for that skill.
      </system-reminder>",
            "type": "text",
          },
        ],
        "result": {
          "content": [
            {
              "text": "<skill_content name="coharness-badge">
      <skill_resources>
      Base directory for this skill: {{badgeAssetsPath}}
      Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.
      </skill_resources>

      <skill_instructions>
      # CoHarness Badge

      Add the official “powered by CoHarness” badge without recreating or restyling it.

      ## Assets

      - Local PNG: [\`coharness-badge.png\`](coharness-badge.png), 726×120 source image; render at 121×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-CoHarness-2563eb?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI%2BPGVsbGlwc2UgY3g9IjIwIiBjeT0iMjYiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjggMjAgMjYpIi8%2BPGVsbGlwc2UgY3g9IjQ0IiBjeT0iMjAiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMzYgNDQgMjApIi8%2BPHBhdGggZD0iTTI2IDE0IHEtMy41LTYtOS41LTcuNSBNMzAuNSAxMi41IHEtLjUtNy00LjUtMTEiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjI5IiBjeT0iMTkiIHI9IjYuOCIgZmlsbD0iI2ZmZiIvPjxlbGxpcHNlIGN4PSIzMy41IiBjeT0iMzAuNSIgcng9IjciIHJ5PSIxMCIgZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJyb3RhdGUoMTYgMzMuNSAzMC41KSIvPjxlbGxpcHNlIGN4PSI0MCIgY3k9IjQ0IiByeD0iNi40IiByeT0iNy4yIiBmaWxsPSIjZGJlYWZlIiB0cmFuc2Zvcm09InJvdGF0ZSgxNiA0MCA0NCkiLz48L3N2Zz4%3D\`
      - Project URL: \`https://github.com/jsjm1986/CoHarness\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-CoHarness-2563eb?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI%2BPGVsbGlwc2UgY3g9IjIwIiBjeT0iMjYiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjggMjAgMjYpIi8%2BPGVsbGlwc2UgY3g9IjQ0IiBjeT0iMjAiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMzYgNDQgMjApIi8%2BPHBhdGggZD0iTTI2IDE0IHEtMy41LTYtOS41LTcuNSBNMzAuNSAxMi41IHEtLjUtNy00LjUtMTEiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjI5IiBjeT0iMTkiIHI9IjYuOCIgZmlsbD0iI2ZmZiIvPjxlbGxpcHNlIGN4PSIzMy41IiBjeT0iMzAuNSIgcng9IjciIHJ5PSIxMCIgZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJyb3RhdGUoMTYgMzMuNSAzMC41KSIvPjxlbGxpcHNlIGN4PSI0MCIgY3k9IjQ0IiByeD0iNi40IiByeT0iNy4yIiBmaWxsPSIjZGJlYWZlIiB0cmFuc2Zvcm09InJvdGF0ZSgxNiA0MCA0NCkiLz48L3N2Zz4%3D)](https://github.com/jsjm1986/CoHarness)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-CoHarness-2563eb?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI%2BPGVsbGlwc2UgY3g9IjIwIiBjeT0iMjYiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjggMjAgMjYpIi8%2BPGVsbGlwc2UgY3g9IjQ0IiBjeT0iMjAiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMzYgNDQgMjApIi8%2BPHBhdGggZD0iTTI2IDE0IHEtMy41LTYtOS41LTcuNSBNMzAuNSAxMi41IHEtLjUtNy00LjUtMTEiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjI5IiBjeT0iMTkiIHI9IjYuOCIgZmlsbD0iI2ZmZiIvPjxlbGxpcHNlIGN4PSIzMy41IiBjeT0iMzAuNSIgcng9IjciIHJ5PSIxMCIgZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJyb3RhdGUoMTYgMzMuNSAzMC41KSIvPjxlbGxpcHNlIGN4PSI0MCIgY3k9IjQ0IiByeD0iNi40IiByeT0iNy4yIiBmaWxsPSIjZGJlYWZlIiB0cmFuc2Zvcm09InJvdGF0ZSgxNiA0MCA0NCkiLz48L3N2Zz4%3D)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For Feishu and other systems that import remote images unreliably, upload \`coharness-badge.png\` from this skill directory instead of generating another badge.
      - Preserve the badge's 121×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.

      </skill_instructions>
      </skill_content>",
              "type": "text",
            },
          ],
          "isError": false,
          "value": {
            "content": "# CoHarness Badge

      Add the official “powered by CoHarness” badge without recreating or restyling it.

      ## Assets

      - Local PNG: [\`coharness-badge.png\`](coharness-badge.png), 726×120 source image; render at 121×20
      - Shields.io image URL: \`https://img.shields.io/badge/powered_by-CoHarness-2563eb?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI%2BPGVsbGlwc2UgY3g9IjIwIiBjeT0iMjYiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjggMjAgMjYpIi8%2BPGVsbGlwc2UgY3g9IjQ0IiBjeT0iMjAiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMzYgNDQgMjApIi8%2BPHBhdGggZD0iTTI2IDE0IHEtMy41LTYtOS41LTcuNSBNMzAuNSAxMi41IHEtLjUtNy00LjUtMTEiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjI5IiBjeT0iMTkiIHI9IjYuOCIgZmlsbD0iI2ZmZiIvPjxlbGxpcHNlIGN4PSIzMy41IiBjeT0iMzAuNSIgcng9IjciIHJ5PSIxMCIgZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJyb3RhdGUoMTYgMzMuNSAzMC41KSIvPjxlbGxpcHNlIGN4PSI0MCIgY3k9IjQ0IiByeD0iNi40IiByeT0iNy4yIiBmaWxsPSIjZGJlYWZlIiB0cmFuc2Zvcm09InJvdGF0ZSgxNiA0MCA0NCkiLz48L3N2Zz4%3D\`
      - Project URL: \`https://github.com/jsjm1986/CoHarness\`

      ## Markdown

      Use this linked badge in Markdown:

      \`\`\`markdown
      [![](https://img.shields.io/badge/powered_by-CoHarness-2563eb?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI%2BPGVsbGlwc2UgY3g9IjIwIiBjeT0iMjYiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjggMjAgMjYpIi8%2BPGVsbGlwc2UgY3g9IjQ0IiBjeT0iMjAiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMzYgNDQgMjApIi8%2BPHBhdGggZD0iTTI2IDE0IHEtMy41LTYtOS41LTcuNSBNMzAuNSAxMi41IHEtLjUtNy00LjUtMTEiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjI5IiBjeT0iMTkiIHI9IjYuOCIgZmlsbD0iI2ZmZiIvPjxlbGxpcHNlIGN4PSIzMy41IiBjeT0iMzAuNSIgcng9IjciIHJ5PSIxMCIgZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJyb3RhdGUoMTYgMzMuNSAzMC41KSIvPjxlbGxpcHNlIGN4PSI0MCIgY3k9IjQ0IiByeD0iNi40IiByeT0iNy4yIiBmaWxsPSIjZGJlYWZlIiB0cmFuc2Zvcm09InJvdGF0ZSgxNiA0MCA0NCkiLz48L3N2Zz4%3D)](https://github.com/jsjm1986/CoHarness)
      \`\`\`

      If attribution should not be linked, use:

      \`\`\`markdown
      ![](https://img.shields.io/badge/powered_by-CoHarness-2563eb?style=flat-square&logo=data:image/svg%2Bxml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI%2BPGVsbGlwc2UgY3g9IjIwIiBjeT0iMjYiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMjggMjAgMjYpIi8%2BPGVsbGlwc2UgY3g9IjQ0IiBjeT0iMjAiIHJ4PSIxMC41IiByeT0iNS41IiBmaWxsPSIjMjU2M2ViIiBzdHJva2U9IiNmZmYiIHN0cm9rZS13aWR0aD0iMi42IiB0cmFuc2Zvcm09InJvdGF0ZSgtMzYgNDQgMjApIi8%2BPHBhdGggZD0iTTI2IDE0IHEtMy41LTYtOS41LTcuNSBNMzAuNSAxMi41IHEtLjUtNy00LjUtMTEiIHN0cm9rZT0iI2ZmZiIgc3Ryb2tlLXdpZHRoPSIxLjkiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjI5IiBjeT0iMTkiIHI9IjYuOCIgZmlsbD0iI2ZmZiIvPjxlbGxpcHNlIGN4PSIzMy41IiBjeT0iMzAuNSIgcng9IjciIHJ5PSIxMCIgZmlsbD0iI2ZmZiIgdHJhbnNmb3JtPSJyb3RhdGUoMTYgMzMuNSAzMC41KSIvPjxlbGxpcHNlIGN4PSI0MCIgY3k9IjQ0IiByeD0iNi40IiByeT0iNy4yIiBmaWxsPSIjZGJlYWZlIiB0cmFuc2Zvcm09InJvdGF0ZSgxNiA0MCA0NCkiLz48L3N2Zz4%3D)
      \`\`\`

      ## Usage rules

      - For GitHub or GitLab Markdown, use the Shields.io URL and link it to the project URL unless the user asks for an unlinked image.
      - For Feishu and other systems that import remote images unreliably, upload \`coharness-badge.png\` from this skill directory instead of generating another badge.
      - Preserve the badge's 121×20 dimensions and aspect ratio.
      - Place the badge at the end of the attributed document or section unless the user specifies another position.
      - Do not substitute another color, logo, label, or project URL.
      ",
            "name": "coharness-badge",
            "provider": "coharness-badge",
            "resourceBase": {
              "kind": "directory",
              "path": "{{badgeAssetsPath}}",
            },
          },
        },
        "summary": {
          "description": "Add the official “powered by CoHarness” badge to documents, pull requests, merge requests, and other content produced with CoHarness. Use whenever creating a pull request or merge request. Also use when the user asks for a CoHarness badge, powered-by-CoHarness attribution, or a reusable CoHarness badge asset or snippet.",
          "invocation": {
            "modelInvocable": true,
            "userInvocable": true,
          },
          "name": "coharness-badge",
          "provider": "coharness-badge",
          "resourceBase": {
            "kind": "directory",
            "path": "{{badgeAssetsPath}}",
          },
          "source": "bundled",
        },
      }
    `)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS * 2)
})

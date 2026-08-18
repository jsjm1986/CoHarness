import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, 'dist/index.html')
await mkdir(dirname(output), { recursive: true })
await writeFile(output, `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>CoHarness</title></head>
  <body><p>正在连接 Web UI…</p></body>
</html>
`, 'utf8')

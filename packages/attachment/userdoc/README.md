# @deepseek-ai/dsh-userdoc

English | [中文](README.zh.md)

The user-document seam. `ctx.userDocs` stores files and folders in the current runtime's document workspace and returns references carrying real absolute paths. Those paths make every document reachable by the agent's own filesystem and shell tools, so the model needs no separate retrieval channel.

This is deliberately the opposite of [`dsh-attachment`](../attachment/README.md), whose objects are content-addressed, private, and invisible to file tools. The two seams coexist: images keep the attachment path because a provider needs their bytes inline, while documents keep the filesystem path because an agent reads them like any other file.

`resolveTarget` is an explicit step, not a default hidden inside `save`: it sanitizes the client-supplied name, resolves the selected directory inside the document root, and returns the exact path `save` will create. Callers resolve first, then stream bytes into `save`, so admission and containment are decided before a single byte is written. `save` enforces `maxFileBytes` against the bytes it receives and leaves nothing behind when it rejects.

`listDirectory` returns one folder's immediate children, while `list` retains the recursive document view used by prompt attachment and older consumers. `createDirectory`, `renameDirectory`, and `removeDirectory` manage ordinary folders; root rename/delete and non-empty deletion are rejected. `move` accepts a document id and destination directory id and never replaces an occupied name. Directory and document ids are opaque root-relative values; providers validate them again whenever they cross into the filesystem.

`mediaType` is recorded verbatim and never verified, parsed, or dispatched on. There is no format allowlist. A harness accepts what a person uploads and lets the agent decide what the file is; server-side parsing, text extraction, and thumbnailing are outside this seam by design.

Storage is not content-addressed, so two uploads of identical bytes are two files with two identifiers. Deleting one cannot affect the other, which is what a person expects of files in their own directory.

## Model Experience

Indirectly, through the host prompt-assembly consumer that either inlines a small decodable document as text or passes its path for the agent's ordinary file tools to read, using the reference and the `maxInlineTextBytes` threshold this seam supplies.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No retention, quota accounting, or garbage collection** — uploads accumulate under the user's own directory until removed. A multi-user deployment enforces disk quota at its own layer, because this seam cannot see the other users sharing the volume.
- **`list` walks one document root** — there is no index or cross-root view, so a very large workspace is scanned in full for recursive consumers.
- **No content verification on read** — unlike the content-addressed attachment path, a document is an ordinary file that anything with filesystem access may have changed since upload, and `bytes` is the length recorded at upload time.

# Mosaic

A local-first Markdown knowledge base for macOS: readable for humans, accessible for AI.
Opens any folder (including an Obsidian vault) and keeps everything as plain files.

Status: early development — see [docs/PLAN.md](docs/PLAN.md).

## Build

Prerequisites: Xcode command line tools, Rust (stable), Node 20+, pnpm.

```sh
pnpm install
pnpm dev          # run in development
pnpm build        # release .app in target/release/bundle/macos/
scripts/check.sh  # format, lint and tests
```

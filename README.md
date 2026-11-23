# Build a static site faster

[![Build a static site faster](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wantorieta15/site-generator-speed-01-run-20261122-akun1/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wantorieta15/site-generator-speed-01-run-20261122-akun1/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A faster drop-in for makefun-site 1.0.0: `run(input)` returns byte-identical
output for every site, much faster than the reference. No dependencies, only
Node's standard library.

## How it is faster

- **Markdown in one pass, no regex in hot paths.** Blocks are classified by
  direct character checks; inline rendering scans once with `charCodeAt`,
  batching plain runs, and returns plain text untouched when it holds no
  special character at all.
- **Templates compiled once per case to JS functions** (`new Function`),
  with array-push output and direct scope lookups — no interpreter walking
  a node tree on every render.
- **Memoized includes.** An include whose result depends only on
  case-stable values (`site`, `tags`, `recent`, or one loop element — e.g.
  the `card`, `header`, and `footer` partials) is rendered once per
  distinct value and reused; anything depending on `page`, `tag`, `posts`,
  `pager`, or `loop` position is never memoized.
- **Cached slugs** (titles and tag names repeat heavily) and manual
  front-matter parsing without per-line regexes.

## Run

```sh
MAKEFUN_INPUT_DIR=/tmp/in MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

`main.ts` reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`),
answers each case with `run()` from `solve.js`, and writes
`/output/answers.json`. Node 22, no network, no dependencies.

## Files

- `solve.js` — the whole generator: front matter, Markdown, templates, build.
- `main.ts` — the driver the harness runs.

# trib-search Default Rules

- `search` is the unified search tool. Routes through raw search and AI search based on `searchMode` config.
- If `search.query` is a string, run a single search. If it's an array, run all queries in parallel.
- `searchMode: "search-first"` — raw search first, AI fallback if insufficient.
- `searchMode: "ai-first"` — AI search first, raw fallback if AI fails.
- `x.com` routes to `grok` x_search. Use `search(query, site: "x.com")`.
- `gh_search` is for GitHub code/repository search. Use for code, libraries, SDKs, open-source.
- `scrape` is for known URL content extraction.
- `map` is for link discovery.
- `crawl` is for multi-page collection.
- Provider and model selection is internal — do not specify providers in tool calls.
- If no provider is available, explain which credential is missing and stop.

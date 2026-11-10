## Performance report

Source: 00c2220c35a36660fd73efa0f309e322504003a4 (dirty benchmark worktree)

| Measurement | Samples | Median | p95 | Unit |
|---|---:|---:|---:|---|
| core.cold_index_5000 | 5 | 422.70 | 485.84 | ms |
| core.warm_index_5000 | 5 | 26.74 | 28.41 | ms |
| core.search_5000 | 100 | 3.98 | 4.14 | ms |
| core.burst_100_sync | 5 | 45.40 | 47.08 | ms |
| core.concurrent_indexers_5000_40_edits | 5 | 1010.98 | 1516.27 | ms |
| browser.mock_external_edit_to_screen_1000 | 5 | 35.00 | 41.77 | ms |
| browser.mock_burst_50_to_screen_1000 | 5 | 30.90 | 47.17 | ms |
| browser.mock_vault_switch_1000 | 5 | 35.89 | 50.66 | ms |
| bundle.js_css_total | 1 | 17578008.00 | 17578008.00 | bytes |
| bundle.js_css_gzip | 1 | 5624329.00 | 5624329.00 | bytes |

- Cold index means empty index database, not flushed OS disk cache.
- Browser measurements use Vite and in-memory mock IPC, not packaged WKWebView.
- Shared runner timings are reporting-only; 25% + absolute margin is provisional, not a release gate.

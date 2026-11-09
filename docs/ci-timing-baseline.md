## CI timing and failure evidence

Run [42266372502](https://github.com/jacquat-jonathan/mosaic/actions/runs/42266372502), attempt 1, source `8768b4bb32327f142a6b7018048f81b55ba92e16`.

Cache class comes only from retained log evidence; unknown is not cold. Job duration includes setup and excludes queue time. Retries shown are observed runner lines, not a flake rate.

| Job | Result | Seconds | Cache evidence | Observed test retries |
| --- | --- | ---: | --- | ---: |
| E2E WebKit (2/2) | success | 750.0 | warm | 0 |
| E2E Chrome (1/2) | success | 567.0 | warm | 0 |
| E2E Chrome (2/2) | success | 601.0 | warm | 0 |
| E2E WebKit (1/2) | success | 629.0 | warm | 0 |
| UI checks | success | 165.0 | warm | 0 |
| Rust | success | 124.0 | warm | 0 |
| UI coverage | success | 65.0 | warm | 0 |

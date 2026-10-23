# shitrat-call

One celld cell that places a single test call to the operator's own number.
A voice worker that is already listening for the room answers and speaks the
reason.

## Bindings

Put these in `.dev.vars` beside `wrangler.jsonc`. The file is gitignored, so it
stays out of the repo; fill it from your secret store. All the values are
account-specific.

| Name | What |
|---|---|
| `SIP_DIAL_URL` | The SIP API endpoint that creates an outbound participant |
| `SIP_PROBE_URL` | A read-only SIP API endpoint, used by `dryRun` |
| `SIP_API_KEY`, `SIP_API_SECRET` | Signs the short-lived bearer token |
| `SIP_TRUNK_ID` | The outbound trunk |
| `CALLEE_NUMBER` | The only number this cell will ever ring |
| `ROOM_PREFIX` | The room name prefix your voice worker listens for |

## Run

```sh
celld dev --port <loopback port> .
curl -X POST http://127.0.0.1:<port>/call -d '{"callId":"probe-1","reason":"probe","dryRun":true}'
curl -X POST http://127.0.0.1:<port>/call -d '{"callId":"test-1","reason":"One plain sentence to speak."}'
curl 'http://127.0.0.1:<port>/call?id=test-1'
```

A call id dials at most once. Repeating it returns the recorded outcome with
`replayed: true`.

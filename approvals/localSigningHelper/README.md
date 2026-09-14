# approvals/localSigningHelper/

The **local signing helper** lets the owner approve from the Dashboard (Approval Center → Approve →
**Sign with local signing helper**) without copying `payload_base64` or running signing commands.

It runs **on the approver's own Windows computer**, never on the server. The server is unchanged: it still
issues the challenge (`approvals/approvalArchitecture.js`), and it still verifies the Ed25519 signature, the
single-use nonce, the execution fingerprint and the expiry before anything is recorded or executed. The helper
only produces the signature the owner used to produce by hand, with the same private key, over the same bytes.

## What keeps it safe

- **The private key never leaves the computer.** It is read from the local file for each signature, used by
  `crypto.sign`, and never logged, sent, or included in any response or error. Responses carry only a base64
  signature, a public-key fingerprint, or an error code.
- **Loopback only.** It listens on `127.0.0.1`, answers only the exact Dashboard origins it was started with,
  and checks the `Host` header (DNS rebinding).
- **Only approval challenges.** It signs only an `ecom-approval-v1` payload: exactly seven lines, a fresh
  `issued_at`, and the approval id, decision, approver and nonce shown in the Dashboard must be the ones inside
  the signed bytes.
- **Every signature needs your "Yes".** A Windows confirmation window (default button **No**) shows what is being
  signed. Page code cannot click it. **No**, closing it, a timeout, or a window that cannot be shown all sign
  nothing. One approval at a time.
- The payload reaches that window only through an environment variable, never inside the PowerShell command
  text.

## Starting it (once per session)

Double-click, or run, `start-local-signing-helper.cmd` with your Dashboard origin and key path:

```
start-local-signing-helper.cmd https://your-dashboard.example.com C:\approval-key\approval-private.pem
```

Both can also come from the environment: `APPROVAL_SIGNER_ALLOWED_ORIGINS` (comma-separated exact origins),
`APPROVAL_PRIVATE_KEY_PATH`, and optionally `APPROVAL_SIGNER_PORT` (default `47321`, which the Dashboard uses).
Keep the window open while approving; close it to stop signing. If the browser asks to allow access to devices
on your local network, allow it for the Dashboard.

## When it refuses

| code | meaning |
|---|---|
| `helper_unreachable` (Dashboard) | helper not running, blocked by the browser's local-network permission, or wrong port |
| `origin_not_allowed` / `host_not_allowed` | request from a page or host the helper was not started for |
| `payload_invalid` / `payload_mismatch` | not an approval challenge, or the shown approval differs from the signed bytes |
| `challenge_expired` | the challenge is older than the server's challenge lifetime - request a new one |
| `busy` | another approval is waiting for your confirmation |
| `declined_by_owner` / `confirmation_timeout` / `confirmation_unavailable` | you chose No, did not answer, or the window could not be shown |
| `key_not_found` / `key_access_denied` / `key_invalid` / `key_not_ed25519` | the key file is missing, locked or protected, unreadable, or not Ed25519 |

At start-up it refuses to run without an allowed origin, with an unreadable key, on a port already in use, or
on a system other than Windows. Manual signing in the Dashboard remains available as a fallback.

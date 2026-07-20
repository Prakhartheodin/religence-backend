# Religence Backend

Starter backend scaffold for the `religance` frontend.

## Quick start

1. Copy `.env.example` to `.env`
1. Install packages:

```bash
npm install
```

1. Start dev server:

```bash
npm run dev
```

Health endpoint: `GET /health`

## Outlook Added

This backend now includes Outlook OAuth + inbox endpoints under ` /v1/email `.

- Start OAuth (browser redirect): `GET /v1/email/auth/microsoft/start?userId=demo-user`
- OAuth callback: `GET /v1/email/auth/microsoft/callback`
- List accounts: `GET /v1/email/accounts`
- List threads: `GET /v1/email/threads?accountId=<id>`
- Get thread: `GET /v1/email/threads/<threadId>?accountId=<id>`
- Send mail: `POST /v1/email/messages/send`

Set these env vars in `.env`:

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_REDIRECT_URI`
- `MICROSOFT_TENANT_ID` (usually `common`)

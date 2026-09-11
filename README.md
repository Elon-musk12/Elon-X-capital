# X-CAPITAL — Neural Horizon v5

Render-ready authentication upgrade for the X-CAPITAL Neural Horizon platform.

## What changed in v5

- Registration now creates a **pending registration**, not a live user account.
- A 6-digit email code is generated with a 10-minute expiry and a 5-attempt limit.
- The real `users` record is created only after successful email verification.
- If the email provider fails, the pending registration is removed and the account is **not created**.
- Verification-code resend has a 60-second cooldown.
- Email delivery uses the Resend HTTPS API, so it works with Render Free's network restrictions.
- SMTP/Nodemailer was removed from the deployment path.
- Render uses the `PORT` environment variable; the project defaults to 10000 in `.env.example`.
- Node 18+ is declared in `package.json`.
- The existing cinematic X-CAPITAL visual design and crypto wallet UX are preserved.

## Email setup

Create a Resend account and create an API key. The current Resend free plan is $0/month with 3,000 emails/month and a 100-email/day limit. Keep the API key private. See the official Resend pricing and Node.js API documentation.

For real users, configure and verify a domain in Resend, then set:

```env
RESEND_API_KEY=re_...
MAIL_FROM=X-CAPITAL <no-reply@your-verified-domain.com>
```

Do **not** put the API key in GitHub. Add it as a secret/environment variable in Render.

For a quick provider test, Resend documents its test addresses and test mode. A verified sending domain is the correct setup when the platform needs to send verification mail to actual users.

## Render deployment

1. Push this project to a GitHub repository.
2. In Render, choose **New → Web Service** and connect the repository.
3. Runtime: Node.
4. Build command: `npm install`.
5. Start command: `npm start`.
6. Select the Free instance while testing.
7. Add environment variables in Render:
   - `NODE_ENV=production`
   - `JWT_SECRET=<long random secret>`
   - `RESEND_API_KEY=<your Resend API key>`
   - `MAIL_FROM=<address on your verified domain>`
   - `DB_FILE=./data/xcapital.db`
   - `ADMIN_EMAIL=<admin email>`
   - `BTC_ADDRESS=<real BTC receiving address>`
   - `USDT_TRC20_ADDRESS=<real TRON USDT receiving address>`
   - `USDC_ERC20_ADDRESS=<real Ethereum USDC receiving address>`
8. Deploy and open the Render `onrender.com` URL.

Render's free web services can host Node/Express apps, but they spin down after inactivity and their local filesystem is ephemeral. A local SQLite database can therefore lose data after restarts, redeploys, or spin-downs. Render Free also blocks outbound SMTP ports 25/465/587, which is why this version uses the HTTPS email API instead of Gmail SMTP.

## Important before real-money use

This project is **not production-ready for accepting customer funds just because it deploys successfully**.

Before real-money use, replace the temporary reference market values with a verified market-data feed or auditable NAV process; connect real blockchain monitoring/confirmation checks; use proper custody controls; add KYC/AML, terms/privacy, rate limiting, security monitoring, backups, withdrawal controls, and the regulatory/legal setup required for the actual business.

The private-company concepts for SpaceX, xAI, Neuralink and Starlink should be represented accurately as private-company/fund exposure where applicable, not as ordinary public stock tickers.

## Local development

```bash
npm install
cp .env.example .env
npm start
```

For local development without an email provider, set `NODE_ENV=development` and omit `RESEND_API_KEY`. The server will print the OTP to the terminal. Do not rely on this development fallback in production.


### SQLite startup directory fix
The server now creates the parent directory of `DB_FILE` automatically before initializing `better-sqlite3`, preventing Render startup failure when `./data/` does not yet exist.


### Express 5 catch-all route fix
The SPA catch-all route uses the Express 5-compatible `/*splat` syntax instead of a bare `*` wildcard.

## Admin auto-bootstrap

If `ADMIN_EMAIL` and `ADMIN_PASSWORD` are configured in Render Environment Variables, the server automatically creates that account as a verified administrator on startup. If the email already exists, the account is promoted to `admin`, marked verified, and its password is synchronized to `ADMIN_PASSWORD`.

This is intentionally limited to the configured admin email; normal investor registrations still require email verification. Keep `ADMIN_PASSWORD` in Render Environment Variables only and never commit it to GitHub.

## Admin auto-bootstrap

If `ADMIN_EMAIL` and `ADMIN_PASSWORD` are configured in Render Environment Variables, the server automatically creates that account as a verified administrator on startup. If the email already exists, the account is promoted to `admin`, marked verified, and its password is synchronized to `ADMIN_PASSWORD`.

This is intentionally limited to the configured admin email; normal investor registrations still require email verification. Keep `ADMIN_PASSWORD` in Render Environment Variables only and never commit it to GitHub.

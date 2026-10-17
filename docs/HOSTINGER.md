# Run OS AI on Hostinger at ostradingai.com

OS AI is a program that runs all the time (agents, backtests, live prices), so it needs a
**Hostinger VPS**. Regular Hostinger web hosting only serves websites and would stop it.

## 1. Get a VPS

hPanel → **VPS** → buy the smallest **KVM** plan (KVM 1 is enough) → choose **Ubuntu 24.04**
(plain OS, no panel) → set a root password. Note the server's **IP address**.

## 2. Point the domain at it

hPanel → **Domains → ostradingai.com → DNS / Nameservers → DNS records**:

| Type | Name  | Points to          |
|------|-------|--------------------|
| A    | `@`   | your VPS IP        |
| A    | `www` | your VPS IP        |

Delete any other `A` records for `@` and `www` first.

> **If your Shopify store already uses ostradingai.com**, don't change `@` and `www`, or the
> store goes offline. Use a subdomain for OS AI instead: add one `A` record named `app`, and in
> step 3 use `app.ostradingai.com`.

DNS changes can take up to an hour.

## 3. Install OS AI

hPanel → VPS → **Browser terminal** (or `ssh root@YOUR-IP`), then paste:

```bash
curl -fsSL https://raw.githubusercontent.com/oageeb7-spec/https-github.com-oageeb7-spec-forex-trading-bot/claude/agentic-trading-system/scripts/hostinger-setup.sh | bash -s -- ostradingai.com
```

(Use `app.ostradingai.com` at the end instead if you chose the subdomain.)

The script installs Node.js, the OS AI code, a service that keeps it running and restarts it,
and Caddy, which gets the HTTPS certificate automatically.

> If the GitHub repository is **private**, the download fails. Either make it public, or upload
> the code zip to `/opt/os-ai` and run the script again.

## 4. Add your keys (this is what makes it real)

```bash
nano /opt/os-ai/.env
```

| Key | What to put |
|-----|-------------|
| `OANDA_API_KEY` | Your OANDA token: real prices. Required. |
| `DASHBOARD_PASSWORD` | A strong password: the site is public, this keeps your trading private. |
| `ANTHROPIC_API_KEY` | Optional: Claude reads and analyzes research sources. |

Save (Ctrl+O, Enter, Ctrl+X), then:

```bash
systemctl restart os-ai
```

Open **https://ostradingai.com**, enter the password (any username), and check the top bar
says **OANDA practice**. That confirms it runs on real prices, not demo data.

## Everyday commands

| What | Command |
|------|---------|
| Is it running? | `systemctl status os-ai` |
| Live log | `journalctl -u os-ai -f` |
| Restart after changing `.env` | `systemctl restart os-ai` |
| Update to the latest code | run the step 3 command again |

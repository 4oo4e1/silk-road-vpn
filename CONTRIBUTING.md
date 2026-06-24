# Contributing to Silk Road VPN

First off, thank you for taking the time to contribute! 🎉

This project is a Telegram Mini App for selling VPN subscriptions, built on
Cloudflare Workers + D1 + KV. The guidelines below keep contributions smooth
and the project secure.

## Code of Conduct

Be respectful and constructive. Harassment, discrimination, or abusive
behavior of any kind will not be tolerated.

## Ways to contribute

- 🐛 **Report bugs** — open an issue with clear reproduction steps.
- 💡 **Suggest features** — open an issue describing the use case.
- 📖 **Improve docs** — fixes to the English or Persian README are very welcome.
- 🌍 **Translations** — additional language READMEs are appreciated.
- 🔧 **Submit code** — see the workflow below.

## Development workflow

1. **Fork** the repository and clone your fork.
2. **Create a branch** for your change:
   ```bash
   git checkout -b feature/short-description
   ```
3. **Set up your environment** (see the README "Installation" section):
   ```bash
   cp wrangler.toml.example wrangler.toml   # fill in your own resource IDs
   npm install -g wrangler
   wrangler dev
   ```
4. **Make your changes.** Keep the existing code style:
   - Vanilla JavaScript (ES modules), no build step.
   - 2-space indentation.
   - Keep customer-facing code away from admin-only VPN fields
     (`worker_email`, `dashboard_password`, `dashboard_url`).
5. **Test locally** against a local D1 database before opening a PR.
6. **Commit** with a clear message and **open a Pull Request** against `main`.

## Security rules for contributors

- **Never commit secrets.** `wrangler.toml`, `.dev.vars`, and `*.log` are
  git-ignored for this reason. Double-check your diff before pushing.
- **Never hardcode** bot tokens, admin IDs, card numbers, or wallet
  addresses in source code — use Worker secrets, `[vars]`, or the
  `settings` table.
- If you discover a security vulnerability, please **do not** open a public
  issue. Report it privately to the maintainer first.

## Pull request checklist

- [ ] My change does not commit any secret or personal data.
- [ ] I kept the existing code style and structure.
- [ ] I updated the documentation (README.md / README_FA.md) if needed.
- [ ] I tested the change locally with `wrangler dev`.

Thanks again for contributing! 💜

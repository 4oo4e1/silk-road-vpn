# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-06-24

### Added
- Initial public open-source release.
- Telegram bot webhook handler (`/start`, Mini App button, admin detection).
- Receipt photo capture for card-to-card payments and wallet recharges.
- Telegram Mini App frontend (home, buy, services, wallet, support, admin panel).
- Mini App REST API with Telegram `initData` HMAC authentication.
- Wallet system: balance, history, recharge presets, card-to-card top-up.
- Plans CRUD and automatic VPN account assignment / fulfillment.
- Subscriptions with renewal and a scheduled (cron) expiry job.
- Support ticket system (customer ↔ admin).
- Admin panel: dashboard stats, users, receipts, plans, VPN inventory,
  subscriptions, settings, and broadcast.
- MIT License, bilingual documentation (English + Persian), contribution
  guide, `wrangler.toml.example`, and screenshot placeholders.

### Security
- Removed all personal data and replaced it with safe placeholders.
- Added `.gitignore` rules so `wrangler.toml`, `.dev.vars`, and logs can
  never be committed.

[1.0.0]: https://github.com/4oo4e1/silk-road-vpn/releases/tag/v1.0.0

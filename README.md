# PAID on Pangea

Every coin launched on [Pangea](https://www.pangea.trade), ranked by what its creator earned from trading fees. Live at **[paidonpangea.xyz](https://paidonpangea.xyz)**.

- `site/` is the page. `site/data.json` is built by `scripts/build.js` and never committed.
- `.github/workflows/pages.yml` rebuilds the data and publishes the site every 10 minutes and on every push.

Creator fees are estimates: Pangea's public trading volume × each pool's trading fee (read from the chain), minus Pangea's share (20% of the fee, at least 0.2% of volume) and, on Solana, Meteora's 20%.

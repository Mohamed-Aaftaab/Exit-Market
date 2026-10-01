# Exit Market web app

The live site at https://exit-market-gamma.vercel.app: Next.js 16 (App Router), wagmi/viem, TanStack Query. It reads
both chains straight from their public RPCs in the browser and talks to the contracts through the shared TypeScript
library in [`../scripts/lib`](../scripts/lib) (imported as `@shared/*`), so the app, the scripts and the keeper
build proofs with the same code.

| Route | What it is |
|---|---|
| `/` | Landing page |
| `/app` | The desk: your Xai Testnet withdrawals, test funds, a sale to the vault in one signature, listings at your price, gasless fast exits, the vault |
| `/explorer` | Every withdrawal through Xai Testnet's standard gateway with its live status, plus the Arbitrum One mainnet snapshot |
| `/pitch` | Pitch deck |
| `/api/relay` | Settles signed fast-exit orders (server-side relayer key; rate-limited, one settlement at a time) |
| `/api/faucet` | Test funds on Xai Testnet, once per address (server-side faucet key) |

## Run it

From the repository root (Node.js 24):

```bash
npm install
npm run web:dev      # http://localhost:3000
npm run web:build    # production build
npm run test:web     # unit tests (web/src/**/*.test.ts)
npm run lint -w web
```

No configuration is needed: contract addresses and the deployment block come from
[`../deployments/arbitrumSepolia.json`](../deployments/arbitrumSepolia.json). [`.env.example`](.env.example) lists the
optional overrides and the two server-only keys (`RELAYER_PRIVATE_KEY`, `FAUCET_PRIVATE_KEY`); without them the relay
and faucet APIs answer 503 and everything else works.

## Notes

- Security headers (CSP limited to the two RPC origins, frame and sniffing protection) are set in
  [`next.config.ts`](next.config.ts); `src/lib/securityHeaders.test.ts` fails if the CSP drifts from the RPCs the app uses.
- Fast-exit orders are kept in the browser (`localStorage`) and polled against `/api/relay` while the desk is open;
  anyone can also settle or reclaim them with `node scripts/selfServe.ts`.
- The link-preview image is `src/app/opengraph-image.tsx`, rendered at build time with Inter from `assets/fonts`
  (SIL OFL).

# Launch posts (drafts — post them yourself)

Recheck each post's length in the X composer. Handles: @arbitrum, @OffchainLabs, @HackQuest_.

Demo video: https://youtu.be/h0rxSgWkFlg

## X thread

**1** (attach the demo video)
```
Leave Arbitrum through the canonical bridge and your tokens sit for 6.4 days.

Arbitrum's token gateway has had a hook to sell a pending withdrawal for years. On the Arbitrum One and Nova mainnet gateways it had never been used.

We made it safe to use: Exit Market https://exit-market-gamma.vercel.app
```

**2**
```
The scale: ~$51M in token withdrawals left Arbitrum One for Ethereum in 30 days. On 2026-09-29, ~$10.2M of token withdrawals sat in the challenge window.

And ~$5M of exits finished the wait but were never claimed.

Method + data: https://github.com/Mohamed-Aaftaab/Exit-Market/tree/main/research/stranded
```

**3**
```
The hook is transferExitAndCall. It lets the owner of a pending withdrawal hand it to another address.

The source says: "It is assumed the _exitNum is validated off-chain."

So no contract could safely buy one.
```

**4**
```
Exit Market is the missing check. Before the 6.4 days end, it rebuilds your withdrawal leaf, folds the Merkle proof and matches the root to a pending rollup node or BOLD assertion that no validator disputes.

Token, amount, destination and "not yet claimed" are all verified on-chain, in the same tx.
```

**5**
```
Then you sell it with one signature: an ERC-4626 vault pays you now, or you list it at your price and any wallet can buy it. The new owner collects the full amount when the challenge period ends.

No gas on the parent chain? Withdraw to our router, sign once, and a relayer settles.
```

**6**
```
Live on Arbitrum Sepolia with Xai Testnet (Orbit L3):
• an exit sold in one signature while still pending
• a gasless exit from a wallet with 0 ETH
• an exit listed at the seller's price and bought by another wallet
• the keeper executed all three; the vault and the buyer were paid

Txs: https://sepolia.arbiscan.io/tx/0xa6eb8d37170fa78f4d386a30a27f8779c08f2a90c9ffa53d138b53f6cce3bf55 · https://sepolia.arbiscan.io/tx/0xdcabb327855c2c00a6dad593f0cd7dd3af7a629ab1bd17f6708625b29d472f57 · https://sepolia.arbiscan.io/tx/0x6ff67081cdb80666962905f0414ffcdb4902df940b2e6ac54ec35c5bbcd77031
```

**7**
```
Beyond testnet: we verify pending BOLD assertions on-chain. On a mainnet fork, a real pending Arbitrum One withdrawal was listed through the real L1 gateway.

The Merkle verifier also runs in Rust on Stylus.
```

**8**
```
Prior art: Moosavi, Salehi, Goldman & Clark, AFT 2023. They showed tradeable exits on a modified Nitro. Exit Market runs on the bridge as deployed.

Try it: https://exit-market-gamma.vercel.app · Code: https://github.com/Mohamed-Aaftaab/Exit-Market

Built for @HackQuest_ Open House Singapore · @arbitrum @OffchainLabs
```

## Discord post

```
Exit Market: sell an in-flight Arbitrum withdrawal instead of waiting 6.4 days

Arbitrum's token gateways have transferExitAndCall, which lets the owner of a pending withdrawal hand it to another address. Nothing validated the exit, so nobody could safely buy one. Exit Market validates it on-chain (a Merkle proof against the rollup's pending root, legacy or BOLD) and lets you sell it to a buyer or an ERC-4626 vault at a small discount.

Live on Arbitrum Sepolia + Xai Testnet: real sales, a listing bought by another wallet, a gasless exit from a wallet with 0 ETH, a keeper that executes and collects. The desk has a test-funds button, so an empty wallet can try it. Also a Stylus (Rust) verifier, and a BOLD verifier proven on an Arbitrum One mainnet fork.

Feedback wanted: which chain and token would you sell first on mainnet?

Demo: https://youtu.be/h0rxSgWkFlg | App: https://exit-market-gamma.vercel.app | Code: https://github.com/Mohamed-Aaftaab/Exit-Market
```

## HackQuest submission summary (≤120 words)

```
Exit Market lets anyone sell an in-flight Arbitrum withdrawal instead of waiting out the 6.4-day challenge period. Arbitrum's token gateways have included transferExitAndCall, a hook to hand off a pending exit, for years, but nothing verified the exit, so nobody could safely buy one. Exit Market proves the token, amount and destination on-chain against the rollup's pending root (legacy and BOLD rollups), then sells it to an ERC-4626 vault or lists it for any buyer. Gasless sign-once exits, a permissionless keeper, a Stylus verifier. Live on Arbitrum Sepolia with Xai Testnet: exits sold, listed and bought, gasless from a zero-ETH wallet, all settled.
```

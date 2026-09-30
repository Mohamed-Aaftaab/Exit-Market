# Launch posts (drafts — post them yourself; fill the [links])

Recheck each post's length in the X composer. Handles: @arbitrum, @OffchainLabs, @HackQuest_.

## X thread

**1** (attach the demo video)
```
Leave Arbitrum through the canonical bridge and your tokens sit for 6.4 days.

Arbitrum's token gateway has had a hook to sell a pending withdrawal for years. On the Arbitrum One and Nova mainnet gateways it had never been used.

We made it safe to use: Exit Market [demo link]
```

**2**
```
The scale: ~$51M in token withdrawals left Arbitrum One for Ethereum in 30 days. On 2026-09-29, ~$10.2M of token withdrawals sat in the challenge window.

And ~$5M of exits finished the wait but were never claimed.

Method + data: [repo link]
```

**3**
```
The hook is transferExitAndCall. It lets the owner of a pending withdrawal hand it to another address.

The source says: "It is assumed the _exitNum is validated off-chain."

So no contract could safely buy one.
```

**4**
```
Exit Market is the missing check. Before the 6.4 days end, it rebuilds your withdrawal leaf, folds the Merkle proof and matches the root to a pending rollup node or BOLD assertion.

Token, amount, destination and "not yet claimed" are all verified on-chain, in the same tx.
```

**5**
```
Then you sell it with one signature. An ERC-4626 vault (or any buyer) pays you now and becomes the owner of the withdrawal. It collects the full amount when the challenge period ends.

No gas on the parent chain? Withdraw to our router, sign once, and a relayer settles.
```

**6**
```
Live on Arbitrum Sepolia with Xai Testnet (Orbit L3):
• a 10 USDG exit sold in one signature
• a gasless exit from a wallet with 0 ETH
• the keeper executed, the vault realized yield

Txs: [sale] [gasless] [collect]
```

**7**
```
Beyond testnet: we verify pending BOLD assertions on-chain. On a mainnet fork, a real pending Arbitrum One withdrawal was listed through the real L1 gateway.

The Merkle verifier also runs in Rust on Stylus.
```

**8**
```
Prior art: Moosavi, Salehi, Goldman & Clark, AFT 2023. They showed tradeable exits on a modified Nitro. Exit Market runs on the bridge as deployed.

Try it: [app URL] · Code: [repo]

Built for @HackQuest_ Open House Singapore · @arbitrum @OffchainLabs
```

## Discord post

```
Exit Market: sell an in-flight Arbitrum withdrawal instead of waiting 6.4 days

Arbitrum's token gateways have transferExitAndCall, which lets the owner of a pending withdrawal hand it to another address. Nothing validated the exit, so nobody could safely buy one. Exit Market validates it on-chain (a Merkle proof against the rollup's pending root, legacy or BOLD) and lets you sell it to a buyer or an ERC-4626 vault at a small discount.

Live on Arbitrum Sepolia + Xai Testnet: real sales, a gasless exit from a wallet with 0 ETH, a keeper that executes and collects. Also a Stylus (Rust) verifier, and a BOLD verifier proven on an Arbitrum One mainnet fork.

Feedback wanted: which chain and token would you sell first on mainnet?

Demo: [video] | App: [URL] | Code: [repo]
```

## HackQuest submission summary (≤120 words)

```
Exit Market lets anyone sell an in-flight Arbitrum withdrawal instead of waiting out the 6.4-day challenge period. Arbitrum's token gateways have included transferExitAndCall, a hook to hand off a pending exit, for years, but nothing verified the exit, so nobody could safely buy one. Exit Market proves the token, amount and destination on-chain against the rollup's pending root (legacy and BOLD rollups), then sells the exit instantly to a buyer or an ERC-4626 vault. It also has gasless sign-once exits, a permissionless keeper and a Stylus verifier. Live on Arbitrum Sepolia with Xai Testnet: real exits sold, a gasless exit from a wallet holding zero ETH, and vault yield realized.
```

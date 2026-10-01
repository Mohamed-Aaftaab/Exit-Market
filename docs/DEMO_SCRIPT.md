# Demo video

The submitted video is `video/out/exit-market-demo-captioned.mp4` (2:58.6, 1080p, burned-in captions, Kokoro text-to-speech narration).
It is built from source, not edited by hand: [`video/script.json`](../video/script.json) holds every scene's visuals
and narration, the app scenes are recorded against the live site by `video/capture/record.ts`, and
`video/assemble.ts` cuts them together. [`video/RECORDING.md`](../video/RECORDING.md) has the rebuild steps.

The table below mirrors `video/script.json`; when the two differ, the JSON is the source of truth.

**Exit Market: the safest way out of Arbitrum, now instant**

| Scene | On screen | Narration (also the captions) |
|---|---|---|
| `01-lock` | 3D shot 1: three glass layers (Xai L3, Arbitrum One, Ethereum); a token capsule is caught in a 6.4-day ring | Leaving Arbitrum the safe way takes six point four days. And once your withdrawal has started, nothing can speed it up. |
| `02-stakes` | 3D shot 1 continues; 2D counters: $51M in 30 days, $10.2M waiting, $5.06M never claimed | In thirty days, fifty-one million dollars in tokens left Arbitrum One this way. On the day we measured, ten million dollars sat in the challenge window, doing nothing. And over five million dollars finished the wait, and was never claimed at all. |
| `03-hook` | 3D shot 2: a sealed gate engraved transferExitAndCall(); overlay: WithdrawRedirected on mainnet: 0 | Arbitrum's token bridge has had a way to sell a pending withdrawal for years. On mainnet, it had never been used. The bridge can't tell a real withdrawal from a fake one, so nobody could safely buy one. |
| `04-proof` | 3D shot 3: Merkle tree; the path lights from your leaf to the root of a pending rollup node; three checks | Exit Market fixes that on chain. It rebuilds your withdrawal, proves it sits in the send root of a rollup node that is still pending, and checks that nobody has claimed it. No oracle. No committee. The market has no owner. Only Arbitrum's own commitments. |
| `05-sale` | App footage: withdraw on Xai Testnet, proof trace turns green, one-signature sale, Arbiscan tx | Here it is, live on an Orbit chain. I withdraw ten USDG from Xai testnet. When the next rollup node is posted, my withdrawal becomes sellable, and the app shows every check. One signature, and the vault pays me nine point nine six USDG, now, not in six days. |
| `06-gasless` | App footage: gasless exit from a wallet holding 0 ETH; relayer settles; Arbiscan tx 0xd11f3260 | No gas on the other side? Withdraw straight to our router, and sign once. This wallet holds zero ETH on Arbitrum Sepolia. A relayer settles the sale and pays the gas, and the USDG still lands. |
| `06b-listing` | App footage: exit #15 listed at 1.99 USDG and shown under Open listings; a second wallet buys it (Arbiscan 0x6ff67081) | Or set your own price. List the withdrawal in one signature, and it appears for every buyer, with its proof checked again on chain. Here a second wallet buys it at that price, and when the challenge period ends, the bridge pays the buyer in full. |
| `07-vault` | 3D shot 4: the capsule enters the vault; USDG streams out; the countdown keeps turning inside the vault | Liquidity providers earn the discount. When the challenge period ends, a permissionless keeper executes the withdrawal, and the vault collects. Idle capital becomes yield. |
| `08-explorer` | App footage: Exit Explorer, every withdrawal on the chain with live status | The Exit Explorer tracks every withdrawal on the chain, live. What is waiting, what is sellable, and what was left stranded. |
| `09-depth` | Proof cards: BOLD mainnet fork (134-deep pending chain, about 1.3M gas); Stylus verifier; tests and six review rounds | And it goes beyond testnet. Arbitrum One runs BOLD, so we verify pending BOLD assertions on chain, and on a mainnet fork we listed a real pending Arbitrum One withdrawal through the real bridge. The proof verifier also runs in Rust, on Stylus. Over four hundred tests, six rounds of security review, and every high severity finding reproduced and fixed. |
| `10-close` | 3D shot 5: the capsule passes through all three layers without stopping; title Exit Market | In twenty twenty three, Offchain Labs researchers showed tradeable exits on a modified Nitro. Exit Market runs on the bridge that is already deployed. The safest way out of Arbitrum, now instant. |

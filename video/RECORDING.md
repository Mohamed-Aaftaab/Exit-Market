# Recording your narration (about 10 minutes of work)

The video is cut to a guide narration (Kokoro TTS). Record the same lines in your own voice, and the edit
re-times itself to your takes.

## Setup

- A quiet room with soft furnishings (a bedroom or closet beats a bare room). Phone voice-memo quality is fine.
- Hold the phone or mic about a hand-width from your mouth, slightly off to the side.
- Record 3 seconds of silence first, in the same room. The mix uses it to remove background noise.

## Takes

One file per segment, named exactly as below (`.wav`, `.m4a` or `.mp3` are all fine). Put them in
`video/voice/`. Speak a little slower than feels natural and smile; it comes through. If you stumble, re-read
the whole line; only your last take per file is used.

| File | Line |
|---|---|
| `01-lock` | Leaving Arbitrum the safe way takes six point four days. And once your withdrawal has started, nothing can speed it up. |
| `02-stakes` | In thirty days, fifty-one million dollars in tokens left Arbitrum One this way. On the day we measured, ten million dollars sat in the challenge window, doing nothing. And over five million dollars finished the wait, and was never claimed at all. |
| `03-hook` | Arbitrum's token bridge has had a way to sell a pending withdrawal for years. On mainnet, it had never been used. The bridge can't tell a real withdrawal from a fake one, so nobody could safely buy one. |
| `04-proof` | Exit Market fixes that on chain. It rebuilds your withdrawal, proves it sits in the send root of a rollup node that is still pending, and checks that nobody has claimed it. No oracle. No multisig. Only Arbitrum's own commitments. |
| `05-sale` | Here it is, live on an Orbit chain. I withdraw ten USDG from Xai testnet. When the next rollup node is posted, my withdrawal becomes sellable, and the app shows every check. One signature, and the vault pays me nine point nine six USDG, now, not in six days. |
| `06-gasless` | No gas on the other side? Withdraw straight to our router, and sign once. This wallet holds zero ETH on Arbitrum Sepolia. A relayer settles the sale and pays the gas, and the USDG still lands. |
| `07-vault` | Liquidity providers earn the discount. When the challenge period ends, a permissionless keeper executes the withdrawal, and the vault collects. Idle capital becomes yield. |
| `08-explorer` | The Exit Explorer tracks every withdrawal on the chain, live. What is waiting, what is sellable, and what was left stranded. |
| `09-depth` | And it goes beyond testnet. Arbitrum One runs BOLD, so we verify pending BOLD assertions on chain, and on a mainnet fork we listed a real pending Arbitrum One withdrawal through the real bridge. The proof verifier also runs in Rust, on Stylus. Over three hundred tests, four rounds of security review, and every high severity finding fixed. |
| `10-close` | In twenty twenty three, Offchain Labs researchers showed tradeable exits on a modified Nitro. Exit Market runs on the bridge that is already deployed. The safest way out of Arbitrum, now instant. |

Then run `node video/assemble.ts`. It picks up `video/voice/` automatically and falls back to the guide
narration for any segment you have not recorded.

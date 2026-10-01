# HackQuest submission

Field by field, in the order the HackQuest project page shows them (modelled on the first-place project of the
MetaMask Smart Accounts Kit x 1Shot API x Venice AI Dev Cook Off). Every figure is from this repository's README and
docs. Images: `video/out/hackquest/` (local, regenerate with the steps at the end).

## Name and one-line intro

**Name:** Exit Market

**Intro:** Sell a pending Arbitrum withdrawal instantly, proven on-chain.

(Alternative: Sell your Arbitrum withdrawal while it is still in the challenge window.)

## Logo, videos, images

- **Logo:** `logo.png` (1024x1024, the site's mark)
- **Demo video:** https://youtu.be/h0rxSgWkFlg (or upload `video/out/exit-market-demo-captioned.mp4` directly, as the
  winner did, so it plays inline)
- **Pitch video:** optional; the same video covers the pitch (problem, primitive, solution, live demo, business)
- **Images, in this order:** `1-hero.png`, `2-features.png`, `3-desk-sell.png`, `4-proof-trace.png`, then
  `5-explorer.png` if a fifth is allowed

## Tech stack

Solidity, Next, Web3, Rust, Node

## Description

Exit Market: sell a pending Arbitrum withdrawal instantly, proven on-chain.

**The problem**
Leaving Arbitrum through the canonical bridge, the only exit that needs no trust beyond the rollup, takes 6.4 days,
and once a withdrawal has started nothing can speed it up. In 30 days, $51M of tokens left Arbitrum One this way. On
one day, $10.2M sat in the challenge window, and $5.06M of exits finished the wait but were never claimed. Fast
bridges have to be chosen before you withdraw, and they skip most Orbit chains: Across supports none of Xai,
ApeChain, RARI, Sanko or EDU Chain.

**What Exit Market does**
Every Arbitrum token gateway has a hook, transferExitAndCall, that lets the owner of a pending withdrawal hand it to
someone else. On mainnet it had never been used, because the gateway cannot tell a real withdrawal from a fake one,
so nobody could safely buy one. Exit Market is the missing check. It proves on-chain, against the rollup's own
commitments, that a withdrawal is real and unclaimed, then in one signature:

- sells it now to an ERC-4626 vault, paid in USDG;
- or lists it at your price for any wallet to buy;
- or, gasless: withdraw to the router and sign one order; a relayer settles it, so you need no ETH on the other side.

The buyer becomes the exit's owner, and the Outbox pays them face value when the window ends.

**Why it can't be gamed**
- Proof, not trust. The market rebuilds the withdrawal's Outbox leaf byte for byte, checks its Merkle path against
  the send root a pending rollup node committed, and checks the Outbox slot is unspent. No oracle, no committee.
- A disputed node stops trading. The verifier walks the pending chain back to the latest confirmed node and refuses
  any root with a rival node at any level.
- No admin. The live market renounced ownership after allowing the gateways: nobody can add a gateway, change the
  fee or move funds.
- Buyers consent, and the relayer cannot steal. The vault must return a consent value before it is charged, and the
  signed order fixes the buyer and the minimum proceeds.

**The output is a product**
Sellers get their money now. Liquidity providers earn the discount (0.10% plus 10% APR on the time left, about 15.7%
APR at full use), and the market takes 0.25%. It runs on the bridge Orbit chains already have, with no upgrade or
opt-in, and a BOLD verifier, proven on an Arbitrum One mainnet fork, extends it to Arbitrum One itself.

## Progress during hackathon

Exit Market was built from scratch during the hackathon, solo, end to end.

**Smart contracts (Solidity, Hardhat 3)**
- ExitMarket: verifies an exit inside the gateway's own hook, then sells it or lists it (list, buy, cancel, settle).
- ExitVault: ERC-4626 USDG vault that prices exits by time to confirmation, values each at cost plus the accrued
  discount, and writes off exits from rejected nodes.
- ExitIntentRouter: gasless sign-once exits (EIP-712), with reclaim and recovery.
- LegacyRootVerifier (pending nodes, rival check) and BoldRootVerifier (BOLD assertions).
- 440 tests (unit, fuzz including a brute-force model of rollup node trees, stateful invariants, exploit regressions)
  plus 10 fork tests against the real Xai and Arbitrum One contracts; 99.42% line coverage; every Slither finding
  triaged; six internal review rounds (AI-assisted, not a third-party audit).

**Verification on Arbitrum's own commitments**
- The Outbox item and its Merkle path rebuilt on-chain, with proofs from NodeInterface.constructOutboxProof.
- Legacy nodes: confirmData = keccak256(blockHash, sendRoot), and a walk to the latest confirmed node.
- BOLD: assertion preimages registered once, every pending ancestor checked. On an Ethereum mainnet fork, a real
  pending Arbitrum One withdrawal was proven under a 134-deep real pending chain and listed through the real L1
  gateway.

**Gasless exits and settlement**
- Withdraw to the router and sign one order; the site's relayer settles it. A wallet holding 0 ETH on Arbitrum
  Sepolia sold its exit this way.
- A permissionless keeper executes each exit once its window ends and collects it for the vault. It runs around the
  clock on GitHub Actions.

**TypeScript SDK and Stylus**
- A viem library shared by the app, scripts, relayer and keeper: legacy and BOLD proof builders, hook encoding,
  listings, the relayer, the keeper's decision table.
- The proof core ported to Rust with Stylus, deployed and checked on-chain against a real Xai send root.

**Live product**
- Next.js app: a landing page; a desk (sell now, list at your price, gasless fast exit, test funds, the vault); a
  live Exit Explorer of every Xai Testnet withdrawal; a pitch deck.
- Every step is a real transaction: exits sold while pending, a listing bought by a second wallet, a gasless exit
  from a wallet with 0 ETH, and the keeper paying them out.

Deployed on Arbitrum Sepolia with Xai Testnet (Orbit L3). Contracts verified on Sourcify.

## Fundraising status

Bootstrapped. Exit Market is a solo, self-funded project built for this hackathon, with no external funding raised
to date. Not currently raising.

## Links and categories

- **Project links:** https://exit-market-gamma.vercel.app · https://github.com/Mohamed-Aaftaab/Exit-Market · your X
  profile
- **Deploy ecosystem:** Arbitrum
- **Sector:** DeFi (add Infra if offered)

## Regenerating the images

The gallery is 3024x1732 (1512x866 at 2x, the same size the winning project used). `1-hero`, `2-features` and
`5-explorer` are captures of the live site; `3-desk-sell` and `4-proof-trace` are frames of the recorded live session
(`video/out/capture/list.mp4` at 5s and 9.5s, extracted with ffmpeg).

# ArtSoul OS — the parts worth checking

[ArtSoul OS](https://artsoul-os.com) — *Operating System*, for a Discord
community: the layer a server runs on instead of six separate bots — is a
Discord bot that charges money in cryptocurrency. From the outside that looks exactly like something you should be
careful with, and it should.

This repository exists so the claims on
[the product's trust page](https://artsoul-os.com/dashboard/docs#trust) can be
checked instead of believed. It is not the product. It is the specific code and
data model those claims rest on, published unmodified so that anybody can read
them and disagree.

## What is here

| | |
|---|---|
| [`src/crypto.service.ts`](src/crypto.service.ts) | The whole payment verifier. Every rule that decides whether a transfer counts. |
| [`src/payment-diagnosis.test.ts`](src/payment-diagnosis.test.ts) | The four distinct ways a payment can be wrong, each pinned by a test. |
| [`src/protection.tracker.ts`](src/protection.tracker.ts) | The spam window — the only place the bot has ever touched message text. |
| [`src/protection-tracker-privacy.test.ts`](src/protection-tracker-privacy.test.ts) | A test that feeds it a message full of secrets and asserts none of it is written down. |
| [`schema/schema.prisma`](schema/schema.prisma) | The complete data model. Every table, every column. |

## What the code says, in the order the claims are made

**"We never hold your money."** There is no balance, no custody, no contract.
Read `crypto.service.ts`: it takes a transaction hash, asks a node what that
transaction did, and compares. It has no ability to move funds — there is no
signing key anywhere in it, because a verifier does not need one.

**"Payment is checked against the chain, not against something we typed in."**
`scanTransfers` parses the `Transfer` logs of the transaction itself and, for
native-coin payments, reads the amount from the transaction and prices it
through a Chainlink feed. Every value it compares comes from the chain.

**"Sending less than the price is not a loss."** Underpayments accumulate
against the invoice rather than being rejected. **"A transaction cannot be
reused."** Each hash is recorded once and refused thereafter.

**"Message content is never stored."** This is the claim that was wrong until
recently, and the honest version is worth stating precisely. The duplicate-spam
filter has to recognise the same message sent twice. It used to keep the text to
do that. It now keeps a truncated one-way hash — enough for an equality test,
useless for reading. The window is seconds long. `protection-tracker-privacy.test.ts`
is the guard, and the commit that changed it is in the history of the private
repository; the column rename from `contents` to `content_hashes` is visible in
`schema.prisma`.

**"We store the minimum."** The schema is complete and unedited. There is no
column anywhere that holds the body of a message. XP counts that a message
happened; `MemberXp` holds a number and a timestamp.

## What is not here

The rest of the product: the bot, the API, the dashboard, the anti-raid
heuristics beyond the tracker above, and the deployment. That code stays closed,
and the reason is specific rather than commercial — publishing the exact
thresholds and evasion paths of an abuse filter helps the people it exists to
stop. If that trade-off bothers you, it is a fair thing to argue about; write to
us.

## No audit badge

There is no third-party security audit and we would rather say so than buy a
badge. Audits are meaningful for smart contracts that hold funds; this product
has no contract and holds none, so an audit would inspect nothing that could
take your money. What is checkable is here, plus two things that are public
anyway: the payout address, shown before you pay, and the permission list
Discord itself presents before you add the bot.

## Reporting something

[`SECURITY.md`](SECURITY.md). Short version: security@artsoul-os.com, and a real
person answers.

## Licence

Apache-2.0. The excerpt is small enough that nobody could build a competing
service from it, and a restrictive licence on a transparency repository would
undercut the point of publishing it. The full product is not open source.

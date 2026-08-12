# ArtSoul OS, the parts worth checking

[ArtSoul OS](https://artsoul-os.com): *Operating System*, for a Discord
community: the layer a server runs on instead of six separate bots, is a
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
| [`src/protection.tracker.ts`](src/protection.tracker.ts) | The spam window: the only place the bot has ever touched message text. |
| [`src/protection-tracker-privacy.test.ts`](src/protection-tracker-privacy.test.ts) | A test that feeds it a message full of secrets and asserts none of it is written down. |
| [`schema/schema.prisma`](schema/schema.prisma) | The complete data model. Every table, every column. |

## What the code says, in the order the claims are made

**"We never hold your money."** There is no balance, no custody, no contract.
Read `crypto.service.ts`: it takes a transaction hash, asks a node what that
transaction did, and compares. It has no ability to move funds, there is no
signing key anywhere in it, because a verifier does not need one.

**"Payment is checked against the chain, not against something we typed in."**
`scanTransfers` parses the `Transfer` logs of the transaction itself and, for
native-coin payments, reads the amount from the transaction and prices it
through a Chainlink feed. Every value it compares comes from the chain.

**"Sending less than the price is not a loss."** Underpayments accumulate
against the invoice rather than being rejected. **"A transaction cannot be
reused."** Each hash is recorded once and refused thereafter.

**"Message content is never stored."** This was wrong until recently, and the
honest version is worth stating precisely, including the limits of what is
proven here.

*The claim:* ArtSoul OS does not persist the body of a Discord message.

*The evidence in this repository:* the complete schema, which has no column that
could hold one; `protection.tracker.ts`, the one component that has ever received
message text, which now keeps a truncated one-way hash rather than the text; and
`protection-tracker-privacy.test.ts`, which feeds it a message full of
recognisable secrets and asserts that no fragment survives into what is written.
The column rename from `contents` to `content_hashes` is visible in the schema.

*What this cannot prove:* the rest of the bot is closed, so these files
demonstrate the claim rather than establishing it for every line we have not
published. The schema is the strongest part of the argument, because a value has
to be stored somewhere and there is nowhere for it to go.

**"We store the minimum."** The schema is complete and unedited. There is no
column anywhere that holds the body of a message. XP counts that a message
happened; `MemberXp` holds a number and a timestamp.

## What is not here

The rest of the product: the bot, the API, the dashboard, the anti-raid
heuristics beyond the tracker above, and the deployment. That code stays closed,
and the reason is specific rather than commercial, publishing the exact
thresholds and evasion paths of an abuse filter helps the people it exists to
stop. If that trade-off bothers you, it is a fair thing to argue about; write to
us.

## No audit badge

There is no third-party security audit yet, and we would rather say that than
buy a badge.

Being non-custodial removes one class of risk: there is no contract holding
funds and no balance to drain. It is worth being precise about what it does not
remove. A review would still have plenty to look at, and some of it is the part
that matters most here: authorisation between one customer's server and
another's, session handling and OAuth, the payment verification in this
repository, privilege escalation through the access levels, and the
infrastructure underneath. We intend to have that review.

Until then, what is checkable is in this repository, plus two things that are
public anyway: the payout address, shown before you pay, and the permission list
Discord itself presents before you add the bot.

The bot carries Discord's verified badge. That is an identity check on the team
behind the app and the thing that lets it grow past 100 servers. It is not a
security audit and we do not present it as one.

## Reporting something

[`SECURITY.md`](SECURITY.md). Short version: security@artsoul-os.com, and a real
person answers.

## Licence

Apache-2.0. The excerpt is small enough that nobody could build a competing
service from it, and a restrictive licence on a transparency repository would
undercut the point of publishing it. The full product is not open source.

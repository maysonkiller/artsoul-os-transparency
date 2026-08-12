# Reporting a security issue

**security@artsoul-os.com**. A person reads it, and you get an answer.

Please write before publishing. Not to keep anything quiet: an unpatched issue
in a live product is a problem for the servers using it, and a few days is
usually enough to close one.

## What to expect

- An acknowledgement within **72 hours**, from a human, not an autoresponder.
- An assessment within **7 days**: whether we agree it is an issue, and what we
  intend to do.
- Credit in the fix, if you want it. Say so, and how you would like to be named.

There is no bug bounty. This is a small product and paying for reports honestly
is not something it can do yet: saying that plainly seems better than a
programme that quietly never pays out.

## In scope

- The API, the dashboard and the bot at **artsoul-os.com**.
- Anything that lets one Discord server reach another server's data.
- Anything that lets a payment be counted twice, counted without being made, or
  attributed to the wrong server.
- Anything that escalates a member above the access level they were granted.
- Anything that exposes message content, which the product states it does not
  store.

## Out of scope

- Denial of service by volume. We know; please do not demonstrate it against the
  live service.
- Findings from automated scanners with no demonstrated impact.
- Missing hardening headers with no exploit path.
- Social engineering of the operator, and physical attacks.
- Discord's own platform. Report those to Discord.

## Please do not

Test against a server you do not own, use a real member's account, or read data
that is not yours. If a proof of concept needs any of that, describe it instead
and we will reproduce it ourselves.

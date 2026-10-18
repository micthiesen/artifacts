# Billing

Workspaces pay for Team through [Creem](https://creem.io), a merchant of
record: Creem is the seller on every invoice, so it collects and remits
sales tax and VAT worldwide and we never register for them. It's the
cheapest merchant of record we found (3.9% + $0.40 a payment, plus an
international payout fee, the greater of $7 or 1%). All of Creem's API is
in `src/worker/billing.ts`, so another provider means replacing that file.

Billing is off until `BILLING=on`. Off, there's no pricing page, no
webhook and no billing in settings; the operator sets plans by hand.

## How it works

- **Pricing** (`/pricing`, on the apex) shows Free and Team ($25 a workspace
  a month; `TEAM_PRICE` in `billing.ts`, which must match the Creem product).
- **Upgrade:** a workspace admin presses "Upgrade to Team" in settings. We
  create a Creem checkout for the Team product with the workspace's slug in
  its metadata and send them there; afterwards Creem sends them back to
  settings.
- **Webhooks** (`POST https://<apex>/api/billing/webhook`) are checked
  against the `creem-signature` header (HMAC-SHA256 of the body with the
  webhook secret). Each workspace has one subscription record in the
  directory's `billing` table, and its plan always follows that record's
  status, never an event on its own:
  - a repeated delivery re-applies the record (so a plan change that failed
    is healed by Creem's retry), and an event older than the last one applied
    changes nothing;
  - events from a subscription the workspace has since replaced can't
    downgrade it; a new subscription takes over only by paying (and the
    Worker logs it, so check the old one was canceled);
  - a workspace on Team set by the operator, with no subscription, is never
    touched by stray events.
  - `checkout.completed`, `subscription.active`, `.paid`, `.trialing` (status
    active or trialing): **Team**.
  - `subscription.canceled`, `.paused`: Team until the end of the period
    already paid for, then Free on its own (Creem's portal cancels at period
    end but sends `canceled` straight away, with the period's end);
    `.scheduled_cancel` likewise.
  - `subscription.past_due`, `.unpaid`, `.expired`: Team stays while Creem
    retries the payment, for up to 14 days past the paid period, then Free.
    Settings asks the payer to update their card.
- **Manage billing** in settings opens Creem's customer portal (card,
  invoices, cancel), for the person who paid only: the portal shows their
  card and everything they pay for. Other admins see who that is. To move
  billing to someone else, they cancel and the new person subscribes.
- **No paying twice:** Upgrade is hidden while a subscription exists (even
  a paused or overdue one) and stays off right after a checkout until the
  payment is confirmed; the server refuses a second checkout too.
- Deleting a workspace with a live subscription is refused (cancel it in
  Creem first, or delete with `?force=1`); deleting removes its billing
  record, so a later workspace with the same address starts clean. Whoever
  made a self-serve workspace can delete it from settings once nothing is
  billed, and then make another.
- Moving to Free keeps everything: every artifact still opens, can be
  edited, shared and commented on. Past Free's limits nothing new can be
  added (artifacts, members, storage) until it trims or upgrades again;
  replacing a file with one no bigger still works. Free also sends fewer
  emails, 20 of its 50 a day kept for invitations and shares.

## Turning it on

1. **Sign up** at creem.io. First check that Creem pays out to your country
   and bank (Canada wasn't confirmed in their docs as of 2026-10-18); if not,
   stop here and we switch provider.
2. **In test mode**, create a product: "Team", subscription, monthly,
   USD 25.00, tax category SaaS. Copy its id (`prod_…`).
3. **Developers → API keys:** copy the test key (`creem_test_…`).
4. **Developers → Webhooks:** add `https://dev.artifacts.boo/api/billing/webhook`
   with all events; copy the signing secret.
5. **Try it on a stage** (nothing touches production):

   ```sh
   BILLING=on SELF_SERVE=on CREEM_API_KEY=creem_test_… CREEM_WEBHOOK_SECRET=… CREEM_PRODUCT_ID=prod_… \
     alchemy deploy --stage dev --yes
   CREEM_WEBHOOK_SECRET=… STAGE=dev bun spikes/e2e-billing.ts
   ```

   The script checks signed webhooks move a workspace between Free and Team
   and that a real sandbox checkout link comes back. Then do it by hand:
   make a workspace at `https://dev.artifacts.boo/workspaces`, press Upgrade,
   pay with Creem's test card (4111 1111 1111 1111, any future date and CVC; 4507 9900 0000 0028 is declined),
   and watch settings say Team. Then cancel from Manage billing: settings
   says Team until the end of the paid period, then Free. (Verified in the
   sandbox on 2026-10-18.) Destroy the stage afterwards.
6. **Live:** repeat steps 2 to 4 in live mode, with the webhook at
   `https://artifacts.boo/api/billing/webhook`. Put the live values in
   `.env` (`BILLING=on`, `CREEM_API_KEY`, `CREEM_WEBHOOK_SECRET`,
   `CREEM_PRODUCT_ID`) and `bun run deploy`. Also set `SELF_SERVE=on` if
   new people should be able to make workspaces themselves.
7. **Check** `https://artifacts.boo/pricing`, then upgrade a workspace of
   your own and refund yourself from Creem's dashboard. A refund doesn't
   cancel the subscription: cancel it too, and the workspace moves to Free.

If Cloudflare's Bot Fight Mode is on for the zone, it can challenge Creem's
webhooks: turn it off, or use Super Bot Fight Mode with a skip rule for
`/api/billing/webhook`.

To turn billing off again, unset `BILLING` and deploy. Paying workspaces
keep their plan, but webhooks are refused until it's back on, and Creem
stops retrying after a day. When you turn it back on, resend the events
from that time from Creem's dashboard (or fix plans by hand in the
operator console).

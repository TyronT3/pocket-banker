# Pocket Banker

A phone banking app for property-trading board game nights. Everyone opens the site on their phone, joins with a 4-letter code, and money moves live between players, the bank and an optional Free Parking pot.

- **Per-game rules**: currency symbol, starting money, GO payout, Free Parking pot, whether balances may go negative, and free-text house rules. Different families or versions can each have their own game.
- **Actions**: Pass GO, collect from bank, pay bank, pay a player, request money (the other player taps Pay), pot in/out, undo.
- **Banker** (the game creator) can move money between anyone and hand the bank to another player.

## Stack

- Static site (no build step) hosted on GitHub Pages.
- Supabase: Postgres + anonymous auth + realtime. All money movement goes through `SECURITY DEFINER` functions in [supabase/schema.sql](supabase/schema.sql); clients can only read rows for games they're in.

## Setup

1. In Supabase, run `supabase/schema.sql` in the SQL editor.
2. Authentication → Sign In / Providers → enable **Allow anonymous sign-ins**.
3. Put the project URL and publishable key in `config.js`.

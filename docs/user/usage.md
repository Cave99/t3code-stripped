# Usage and limits

Open **Usage** from the sidebar or the command palette, or press `mod+u` when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

## Understand your usage

**Usage** combines Codex and Claude Code history on this machine. It shows token use,
cache savings, model breakdowns, and estimated API-equivalent cost by token type and speed. These estimates are not your
subscription bill. **Premium** is the extra cost of Fast and Ultrafast requests.
Select a model under **Breakdown** to see its trend, cache hit rate, and cost per million tokens.

Use the provider filter to choose which providers contribute to costs, tokens, model shares, and limits.
Your selection is saved across visits.

Usage includes each configured account's history, including disabled accounts. Custom homes follow
the account's home setting or its `CODEX_HOME` or `CLAUDE_CONFIG_DIR` environment
variable. Use absolute paths or `~/` paths in the account's environment settings; relative
environment paths depend on each project's working directory and cannot be reliably discovered
by Usage. Accounts sharing a history directory count once.

If recent work is missing or a new model shows no cost, refresh to rescan session history and
update model pricing.

## Set custom model prices

On **Usage**, choose **Model prices** to add, edit, or reset a model's estimated price.
Enter the exact model ID and USD rates per million input and output tokens, including models
without public pricing. Cache read and write rates are optional and use the input rate when
blank; enter `0` for free tokens.

Saved prices apply to local history. Edit rates in the table and choose **Save changes**.
**Reset to automatic** removes an override when you save; you can undo it before saving.
If saving fails, reconnect and choose **Retry failed saves**.

Use **Maps to** in **Model prices** to fold a preview model ID into its released model.
Mapped usage uses the target model's prices. Clear the mapping to show the original ID again.

## Track subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts configured locally you read one number per window rather than a list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their 5-hour reset, soonest
first, or by the first available window when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Select a segment or account row for the account's plan,
where it is signed in, and its reset time. Codex accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Select a row to open its details.

The same account reported by multiple local instances counts once.

Opening Limits checks subscription usage automatically. The app waits at least five minutes
between automatic checks, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Keyboard shortcuts

Open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.

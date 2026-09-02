# Pocket passive usage identity

## Goal

Pocket should show saved GPT usage without claiming that SwiftBar's default
account is the account a Conductor chat is using. The readout must remain
passive. Opening Pocket or its Usage sheet must not probe an account, refresh a
token, switch an account, notify the operator, or affect a running chat.

## Root cause

Pocket currently marks the account named by `~/.codex-accounts/.active` as
`Active`. That file is SwiftBar's default account pointer. Conductor can move a
chat to another saved account when the default is capped, and it records the
latest successful choice in `.conductor-rotation-state.json`.

The current state demonstrates the bug. SwiftBar points to `seat2`, whose cached
weekly usage is 100 percent. Conductor's passive rotation record says its last
successful account was `seat3`, whose cached weekly usage is 91 percent. Pocket
therefore reports a true percentage under a false identity label.

## Chosen design

Pocket will expose two different facts instead of one overloaded `active` flag:

- `Default` means the account named by SwiftBar's `.active` pointer.
- `Last used by Conductor` means the account named by the rotation record's
  `lastActive` field.

The Usage sheet will show both labels when they apply. The small header glance
will use only the last account observed by Conductor and will say `Last GPT 91%`
instead of implying that the account is active in every chat.

This is deliberately less ambitious than exact account tracking per chat. A
single Conductor process can host several chats, and each app server can rotate
independently. Exact live identity would require a new per-session reporting
contract. The passive rotation record answers the useful question without adding
coordination or work to the send path.

## Data flow

The existing GPT reader will continue to read only:

- account filenames and labels from `~/.codex-accounts`
- SwiftBar's cached usage JSON
- SwiftBar's `.active` pointer
- Conductor's rotation state JSON

The reader will whitelist account name, label, cached percentages, reset times,
login state, sample age, default identity, and latest Conductor identity. It will
not open saved account snapshots, which contain credentials.

The `/api/usage` response will carry the two identity facts to the existing
client cache. The client will select `lastUsedByConductor` for the header glance.
The Usage sheet will render `Default` and `Last used by Conductor` as plain status
labels.

## Failure behavior

- A missing or unreadable rotation record produces no Conductor identity label.
  Pocket will not guess.
- A rotation record that names an account absent from the usage list is ignored.
- A missing SwiftBar pointer produces no Default label.
- A missing or old usage sample remains `No data yet` or `cached`, with its sample
  age shown.
- One bad source cannot break chat reading or sending.

## Safety boundary

This change adds no network call to OpenAI or Anthropic. It does not invoke the
local Claude profiles endpoint. It does not call account switching, token
refresh, notification, or login code. It does not decide whether a send is
allowed. The Conductor rotation wrapper remains the authority for that decision.

## Tests

Regression coverage will prove:

1. A capped SwiftBar default and a different latest Conductor account receive
   different labels.
2. The header selector chooses the latest Conductor account, not the capped
   default.
3. Missing, corrupt, stale, or unknown rotation state produces no false active
   claim.
4. The reader opens only the approved metadata and cache paths.
5. Usage failures remain isolated from chat and connection rendering.
6. The public shell revision changes with the client module so installed phone
   apps cannot keep the old identity behavior.

## Non goals

This change will not add account switching, account refresh, alerts, automatic
login, exact per-chat identity, or new background polling.

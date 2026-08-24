# Conductor Pocket Calm Motion Design

## Problem

Pocket changes state correctly, but several changes do not preserve visual continuity.
Measured on the 390 by 844 fixture:

- The usage sheet enters at 84 px tall, then grows to 633 px while its 380 ms entrance is already running.
- Sheet dismissal removes the overlay in the same frame as the tap.
- Chat switching replaces the transcript and resets its scroll position at frame zero. The header and chat strip are also rebuilt during refreshes.

These are layout and lifecycle defects. Different easing alone will not fix them.

## Outcome

Pocket should feel calm and native on an iPhone:

- The app shell stays fixed while content changes.
- Movement explains where content came from or where it went.
- No element changes size during its own entrance or exit.
- A tap receives visible feedback in the next frame.
- Reduced-motion users get the same stable geometry without translation or scale effects.

## Motion System

Use four shared motion values:

- Quick feedback: 100 ms.
- Content transition: 140 ms.
- Overlay exit: 160 ms.
- Overlay entrance: 220 ms.

Entering uses an ease-out curve. Exiting uses an ease-in curve. Content replacement uses ease-in-out. Only opacity and transform animate.

## Sheets and Overlays

Data-heavy sheets receive their final viewport height before entrance starts. Their content area owns scrolling, and loading content uses stable placeholders inside that height.

Opening behavior:

1. Insert the scrim and final-size sheet.
2. Paint the initial state.
3. Animate scrim opacity and sheet translation.
4. Allow asynchronous content to replace placeholders without changing sheet geometry.

Closing behavior:

1. Mark the overlay as closing and block repeat taps.
2. Animate scrim opacity and sheet translation for 160 ms.
3. Remove the overlay and restore focus after the exit completes.
4. Use a bounded fallback timer so a missing animation event cannot trap the interface.

Reduced motion removes translation and completes lifecycle changes immediately.

## Chat Switching

The header, chat strip, transcript viewport, composer, and safe-area geometry remain mounted.

The destination chat paints from memory or cache before network refresh work. If it is not available yet, the current shell stays fixed and a stable loading state occupies the transcript viewport. When the destination is ready, only transcript content receives a 140 ms opacity and small vertical transform entrance.

The active chat chip scrolls into view without moving the transcript. Repeated refreshes update text and status in place instead of replaying the transition.

## Other UI States

The same tokens apply to visible state changes that currently snap:

- Connection and error banners fade and translate without changing surrounding geometry mid-transition.
- The Latest control and transient feedback use quick opacity and transform motion.
- Loading placeholders match the final component dimensions.
- Buttons retain the existing pressed feedback and never animate layout properties.

No decorative motion is added. Working status keeps its existing calm pulse unless the reduced-motion preference disables it.

## Failure Handling

- A second overlay open request closes the current overlay cleanly before replacing it.
- Escape, scrim tap, close button, and programmatic close share one exit path.
- Focus restoration runs once, even when close is requested twice.
- Network or usage-provider failure changes sheet content, not sheet geometry.
- Motion never delays a send, lock, sign-out, or safety action.

## Verification

- Automated regression tests cover final sheet geometry, bounded exit cleanup, stable chat shell behavior, shared motion tokens, and reduced motion.
- Motion captures sample geometry at 0, 16, 50, 100, 180, 280, and 420 ms.
- Phone review runs at 320 by 568 and 390 by 844.
- The full Pocket test suite, live installer, live verifier, and doctor must pass before completion.

## Scope

This work changes Pocket browser presentation and local relay shell assets only. It does not alter model selection, paid APIs, message delivery semantics, live DM systems, credentials, or database schemas.

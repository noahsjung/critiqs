# Thread page on the website

Every thread has a page on the website at `/t/<pageKey>` that shows the comment, its saved screenshot, and
"Open in prototype" and "Copy link".

## Sub-features

- `view`: heading "Comment on <project>", screen name, the saved capture, and the messages.
- `open-in-prototype`: opens the prototype's address ("Opens 127.0.0.1:<port>").
- `sign-in`: a signed-out visitor is asked to sign in before seeing the thread.

## How to get to it (user POV)

A link to the thread (Copy link in the widget, or a notification email) opens `/t/<pageKey>`.

## Driving it with walk.sh

The last step of `walk.sh --feature comment`, **thread-page**: find the comment's `messages` row, take its
`threadId`, read that thread's `pageKey` from `threads`, open `/t/<pageKey>`, sign in if asked, and wait until
the page shows the comment's words.

## Gotchas

- The words are in `messages.body`, not on the `threads` row.
- The capture can take a few seconds to appear; the walk waits for the words, not the image.

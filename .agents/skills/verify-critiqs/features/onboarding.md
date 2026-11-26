# Onboarding on the website

A new person tells Critiqs what their team should review, signs in, chooses who adds Critiqs to the prototype,
and gets the install command for a new project.

## Sub-features

- `address`: "What should your team review?" with a "Prototype link" field, or "It's not online yet".
- `sign-in`: Continue opens the backend's sign-in window (email, development code, name).
- `who`: "Who will add Critiqs to it?" with "I will" or "My developer will". Choosing creates the project.
- `setup`: "Add Critiqs to your prototype" with `npx critiqs-react init <project ID>` and Copy command.

## How to get to it (user POV)

Open the website at `/start` (any unknown path also lands there).

## Driving it with walk.sh

`walk.sh --feature onboarding`. Steps and end states:

- **onboarding-address**: the heading "What should your team review?" shows; fill "Prototype link" with
  `https://prototype.example`.
- **onboarding-sign-in**: click Continue; the sign-in window opens; the walk enters the email, reads
  "Development code: NNNNNN" off the window, enters a name and allows. The page shows "Who will add Critiqs
  to it?".
- **onboarding-project-created**: click "I will"; "Add Critiqs to your prototype" shows with the init
  command, and `projects` has a row with the address.

## Gotchas

- "Sign in with email" appears only when the browser blocked the sign-in window; the walk handles both.
- An `http://` address isn't saved as the review link ("isn't HTTPS"); use `https://`.
- "My developer will" sends email. Without a mail service the deployment reports `developerEmails: false` in
  `/critiqs/config`, and sending isn't proven here.

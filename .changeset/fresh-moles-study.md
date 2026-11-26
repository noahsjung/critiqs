---
"critiqs-react": patch
---

Reviewers stay signed in when the browser closes or the page unloads during a sign-in refresh, and loading a page no longer refreshes a sign-in that is still good. The component and the `critiqs` command save the refresh token they ask for before asking, and the sign-in service finishes a refresh whose answer was lost when it is sent again. Reusing a replaced refresh token any other way now ends the session. Deploy the backend to get the protection; older components keep working with it.

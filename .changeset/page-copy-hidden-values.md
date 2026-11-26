---
"critiqs": patch
"critiqs-react": patch
---

Page copies for mockups no longer carry values the page never shows: hidden form fields (often a form's anti-forgery token or an ID) are copied empty, and anti-forgery `<meta>` tags such as Rails's `csrf-token` are left out.

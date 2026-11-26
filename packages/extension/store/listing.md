# Chrome Web Store listing

What to enter in the Chrome Web Store's developer dashboard when uploading
`release/critiqs-extension-<version>.zip` (`bun run package`). Keep it in step
with the manifest: a new permission needs a justification here before it ships.

## Before the first upload

- **A privacy policy URL.** The store requires one for an extension that
  handles personal data. Critiqs's website has no privacy page yet; one has to
  be published first.
- **Screenshots.** At least one, 1280×800 or 640×400: the page with pins and
  the side panel beside it, and the Mockup tab. `bun run check:checklist`
  saves both as it runs.
- **A small promo tile**, 440×280, if the listing should have one.

## Listing

**Name:** Critiqs

**Summary** (at most 132 characters):

> Comment on any page you can open, without the team installing anything.

**Category:** Developer Tools

**Description:**

> Critiqs lets you leave feedback on a web page in place: on a staging site,
> a prototype, a logged-in app, or a page on your own computer. Click the
> Critiqs icon, and the side panel opens beside the page.
>
> - Comment on an element: pick it on the page, write, and a pin marks it.
>   The comment keeps a screenshot of what you saw.
> - Your team sees the same pins and threads, replies, and resolves them.
> - Copy a comment's link to share it. It opens on Critiqs's website, even for
>   people without the extension.
> - Mockup mode freezes the page into a copy beside it, where you ask Critiqs
>   AI for a change and see the new version.
> - Sites with Critiqs already built in keep their own; the extension stays
>   out of the way.
>
> Critiqs asks for no access to your sites when you install it. It reads a page
> only after you click its icon there. To show comments on a site without a
> click, turn on **Show comments here automatically** in the panel's
> settings: Chrome then asks you for that one site.

## Single purpose

> Leave and read review comments on the web page in the current tab, for a
> Critiqs project.

## Permission justifications

| Permission | Why Critiqs needs it |
| --- | --- |
| `activeTab` | When the person clicks the Critiqs icon, Critiqs adds its comment layer (pins, element selection) to that tab and takes the screenshot a new comment keeps. It has no access to the page before that click. |
| `sidePanel` | Critiqs's panel (sign-in, comments, settings) shows in Chrome's side panel beside the page, so it never covers the page being reviewed. |
| `scripting` | Adds Critiqs's comment layer to the tab after the click. For a site where the person turned on **Show comments here automatically**, registers the layer for that one site so pins show on later visits. |
| `storage` | Keeps the person signed in, the project they chose for each site, and their settings, on this computer. |
| Optional host access (`<all_urls>`) | Never asked for at install. Requested for one site at a time, only when the person turns on **Show comments here automatically** for it, and given back when they turn it off. |

**Remote code:** No. Every script is in the package. Mockup mode shows a copy
of the page in a frame where no script runs.

## Data use

What the store's privacy practices form asks, answered for this version:

| Data | Collected | What for |
| --- | --- | --- |
| Personally identifiable information | Yes: email address and display name | Signing in, and showing who wrote a comment |
| Authentication information | Yes: sign-in tokens, kept in the extension on this computer | Staying signed in |
| Website content | Yes, only on pages where the person uses Critiqs: the comments they write, a screenshot of the visible page with each comment, the page's address and the element commented on, and, in Mockup mode, a copy of the page | The review comments themselves |
| Web history | No list of visited pages. A page's address goes to Critiqs only when the person opens Critiqs on it, comments on it, or turned on its automatic comments | |
| Everything else (health, financial, location, personal communications, user activity) | No | |

Data is not sold, not used for anything but Critiqs itself, and not used to
decide credit or lending.

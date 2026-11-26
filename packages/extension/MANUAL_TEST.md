# Manual test in real Chrome

`bun run check:checklist` runs these steps in Chrome for Testing and reports
each one (see the [README](README.md#checks)). Three things still need a
person: Chrome's prompt in step 10, whether step 14's site leaves **Site
access** after allowing it through that prompt, and the keyboard shortcut in
step 18. By hand, the whole list takes about 10 minutes.

## Before you start

1. Build for the backend to test against. For Critiqs Cloud: `bun run build`
   in `packages/extension`. For a local backend:
   `CRITIQS_BACKEND=http://127.0.0.1:<port> bun run build`.
2. Make sure that backend lists the extension ID
   `pfdpnmmiemejphfghkalofichdcoandg` in `CRITIQS_EXTENSION_IDS`.
3. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose
   **Load unpacked**, and pick `packages/extension/dist`.
4. Check: Chrome shows the ID `pfdpnmmiemejphfghkalofichdcoandg`, and
   **Details → Site access** says the extension has no access to sites.
5. Pin Critiqs to the toolbar (puzzle-piece menu → pin).

You need a page to review: any site you can open, such as a staging app.
Write down its address: ________________

## Steps

| # | Do | Expect | Result |
| --- | --- | --- | --- |
| 1 | Open the page. Click the Critiqs icon. | The side panel opens beside the page and shows **Sign in to Critiqs**. | |
| 2 | Enter your email and choose **Send code**. | **Check your email**. A code arrives by email (a local backend shows it in the panel). | |
| 3 | Enter the code and choose **Continue**. If it's your first sign-in, enter a name. | The panel shows the project for the page, or **No project for this site yet**. | |
| 4 | If there's no project, choose **Start reviewing this site**. | Critiqs's panel shows, with the site's name at the top and the toolbar at the bottom, with a Mockup mode button where the backend stores mockups (Critiqs Cloud). | |
| 5 | Choose Comment mode (the speech-bubble button), then click an element on the page. | The element is outlined on the page, and the new comment's box opens in the side panel. | |
| 6 | Write a comment and choose **Comment**. | A pin appears beside the element on the page. The comment opens in the side panel. | |
| 7 | Look at the comment's screenshot. If the page has a video, canvas, or embedded frame, check that it shows as on screen. | The screenshot is the page as on screen (real pixels). No note about screenshots appears. | |
| 8 | Reload the page (Cmd+R). | The panel asks you to click the Critiqs icon on this page. | |
| 9 | Click the Critiqs icon again. | The pin comes back, and the panel shows the project again. | |
| 10 | Choose **Settings** in the panel, then turn on **Show comments here automatically**. | Chrome asks to allow Critiqs on this one site. Allow it. The switch stays on. | |
| 11 | With the side panel still open, reload the page, and don't click the icon. Make another comment. | The panel reconnects by itself, and the comment saves. Chrome keeps the icon's grant through a reload of the same site, so the screenshot is still real pixels. After the tab has opened another site and come back, Chrome refuses the screenshot without a click, and the panel says once: "For screenshots with real pixels, click the Critiqs icon on this page." | |
| 12 | Close the side panel (its X). Reload the page. | Pins show on the page without clicking the icon. | |
| 13 | Click a pin. | The side panel opens on the pin's comment (Chrome 151). Write down if your Chrome does nothing instead. | |
| 14 | Click the icon, then in **Settings** turn the switch off. Close the panel and reload. | No pins until you click the icon. `chrome://extensions` → Critiqs → **Details → Site access** no longer lists the site. | |
| 15 | Open a site with Critiqs installed (with `<Critiqs />` or the script tag). Click the icon. | The panel says **Built in**, and only the site's own Critiqs is on the page. | |
| 16 | Open `chrome://extensions` in a tab and click the icon. | The panel says **Critiqs can't open here**. | |
| 17 | Back on the first page: **Settings → Sign out**. | The panel shows **Sign in to Critiqs**. Signing in again with the same email skips the name. | |
| 18 | Press Alt+Shift+C on a page. | Same as clicking the icon. | |
| 19 | Open a second site that no project lists. Click the icon, then choose **Add to a project**. | The list shows the projects you created and, if you're an admin of an organization, its other projects too. When they come from more than one organization, each shows its organization's name. Choose one. Critiqs's panel shows that project, and reopening the panel on this site shows it again. | |
| 20 | On that site, make a comment, then choose **⋯ → Copy link** on it. Open the copied link in a new tab. | "Link to thread copied". On a deployment with a website (Critiqs Cloud, or `CRITIQS_WEB_URL` set), the link is the comment's page there, `<website>/t/<key>`: it asks who you are, and after you sign in with the same email it shows the comment and its screenshot, for people without the extension too. Without a website, the link is the page's own address with the comment in it, which opens the comment where the page has Critiqs installed or the extension is clicked. | |
| 21 | In the side panel, choose **Mockup mode** (the toolbar button, or M). | A tab opens beside the page with the page frozen into a copy, Critiqs's toolbar, and the Mockup panel on the right. | |
| 22 | Choose **New thread**, click an element of the copy, ask for a change, and choose **Send**. | The thread opens in the Mockup panel with your message. Critiqs AI answers with a new version, or says why it can't (such as AI not set up for the project). | |
| 23 | Press V. | The Mockup tab closes, and the page's tab is in front with its side panel. | |

## Report

Chrome version (`chrome://version`): ________________

Note any step whose result differs, with a screenshot of the side panel.

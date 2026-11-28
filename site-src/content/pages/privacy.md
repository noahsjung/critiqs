---
title: Privacy policy
description: What Critiqs Cloud, the critiqs.app website, and the Critiqs browser extension collect, why, who else receives it, how long it's kept, and your choices.
---

**Effective date:** November 27, 2026

## Who we are

Critiqs is a tool for leaving comments on web pages, prototypes, and staging sites. In this policy, "Critiqs", "we", and "us" mean Noah Jung, 4068 Watercourse Dr. #2407, Fort Worth, TX 76109, United States.

This policy covers:

- **Critiqs Cloud**, the hosted service that signs people in, stores comments, and sends email.
- **The critiqs.app website**, including its setup, thread, and review pages.
- **The Critiqs browser extension** for Chrome and other Chromium browsers.

It doesn't cover Critiqs that a team runs on its own servers. See [Self-hosted Critiqs](#self-hosted-critiqs).

Questions about this policy or your data: [noahsjung@gmail.com](mailto:noahsjung@gmail.com).

For people in the EEA or UK, Critiqs acts as a data controller for account, sign-in, security, and billing data—relying on performance of a contract to provide the service, legitimate interests in keeping Critiqs secure and reliable, and legal obligations—and acts as a data processor for project comments, screenshots, and page copies, where the team or organization owning the project is the controller.

## What we collect and why

### Your account

- **Email address.** You sign in with a code we email to it. We also send it the emails listed under [Email](#email).
- **Display name.** You choose it at your first sign-in. People in your projects see it beside your comments, and you can change it.
- **Organizations.** The organizations you belong to, your role in each (admin or member), and invitations. An invitation holds the invited email address until it's accepted. Admins of an organization see its members' email addresses.
- **Onboarding answers, if you give them.** Your role and team size, and for a project: who gives feedback, what the review is for, and the site's framework. You can skip them. We use them to suggest how to set the project up.
- **Sign-in records.** A session for each site or tool you sign in to, and the sites you allowed to use your Critiqs account. We store session tokens only as hashes. A session ends 30 days after you last use it, and never lasts more than 90 days.

Critiqs's own database doesn't store your IP address. The companies that host Critiqs receive it with every request, as any web host does.

### Comments, replies, and screenshots

- **What you write:** comments, replies, edits, reactions, tags, and the people you mention.
- **A screenshot with each new comment:** a picture of the part of the page you could see, with the element you commented on outlined, or an image you attach instead. A screenshot shows whatever was on screen, including other people's information if the page showed it. A site that has Critiqs built in can hide parts of its pages from screenshots. Screenshots taken by the extension are a picture of the visible tab.
- **Where the comment was left:** the page's address, the screen and view (such as an open tab or dialog), the element you commented on (its label, tag, role, and place in the page), the window size, your browser's name and version, the time, and the build version the site reports.
- **Read state:** which threads you have read.

Everyone who can review the project sees its comments and screenshots: its organization's members, or anyone who signs in, if the project's owners opened it to anyone.

### Page addresses and the element you comment on

We use a page's address to find its project. A project keeps a list of its sites' addresses. When you open Critiqs on a page, Critiqs looks for the project by the page's origin (such as `https://staging.example.com`) among the organizations you belong to. We record when Critiqs first loaded on a page with a project, and that page's origin.

We don't collect a list of the pages you visit. A page's address reaches Critiqs only when you open Critiqs on it, comment on it, or turned on automatic comments for its site.

### Page copies

Mockup mode saves a copy of the page's HTML as you see it, so you and Critiqs AI can propose changes to it. The copy holds the page's visible text and form values. Password fields are replaced with bullets, regions the site marked as hidden are blanked, and some values only the page's scripts read, such as hidden form fields and security tokens, are left out. We keep copies until the mockup is deleted. Deleting a mockup deletes its copies and versions at once.

### Usage counts

For plan limits, Critiqs Cloud counts, per project or organization: projects, threads, comments, people who commented this month, image storage, mention emails, and Critiqs AI credits. These are counts, not content. To count each person once a month, we record who has already been counted.

The website has no analytics, advertising, or tracking cookies, and the Critiqs packages that sites install contain no analytics.

### Email

We send these emails:

- **Sign-in codes.**
- **Mention and reply emails.** When someone mentions you, or replies in a thread you're in. They contain the thread's comments, their authors' names, and its screenshot. Each one has links to mute that project or unsubscribe from all of them, and you can change the same choices in Critiqs's account menu.
- **Invitations** to an organization, sent to the address an admin enters.
- **Setup steps** a project's owner sends to a developer's address they enter.
- **Credit alerts** to an organization's admins when it has used its plan's Critiqs AI credits, and when none are left.

We keep the record of a mention or reply email for 30 days after it's sent. For setup steps, we keep the developer's address and a copy of the latest email with the project, so a resend is the same email. If someone reports our email as unwanted, we keep their address so we stop sending it invitations and setup steps.

### Trackers

If you connect a Linear, GitHub, or Jira account, we store its account ID, name, workspace or site, and its access tokens. We encrypt the tokens (AES-256-GCM) and never show them to anyone. Signing in to a tracker connects it only when the tracker account uses the same email address as your Critiqs account, so the tracker tells us that address.

When you create a ticket from a thread, we send the tracker the ticket's text: by default the thread's first comment, its link, the screen and element, its tags, and the whole discussion with authors' names. Linear and Jira also get the screenshot. We store the link between the thread and the ticket, the ticket's title, and its status. For Jira we register a webhook so Jira tells us when a ticket's status changes.

Disconnecting a tracker deletes its stored tokens. Tickets already linked keep their links.

### AI

Critiqs uses AI for grouping tags, search, Mockup mode, and drafting tickets. A request goes either to **Critiqs AI**, which Critiqs Cloud runs, or to an AI provider whose key you or your project's owners saved. The project's owners choose which.

What reaches the AI provider:

| Feature | What's sent |
| --- | --- |
| Grouping tags | Tag names and group names |
| Search | Your question, the project's tag and group names, and the matching threads' comments with their authors' display names, status, screen, and tags |
| Mockup mode | The mockup thread's messages, the text of threads added to it, its current changes, and a description of the page copy's elements (tags, classes, text, some styles), without hidden regions |
| Drafting a ticket | The thread's messages, tags, screen, element, and scope |

We never send AI providers email addresses, keys, screenshots, or another project's data. A project's owners can turn AI off; then nothing from the project reaches any provider.

If you save your own provider key, we encrypt it (AES-256-GCM) and keep only its last four characters readable. Requests go from our servers straight to the provider you chose, under that provider's terms.

Critiqs AI's provider: when managed Critiqs AI is enabled, requests go to commercial AI API providers (such as OpenAI, Anthropic, or Google) under API terms that prohibit training models on API requests and retain request logs only briefly for abuse monitoring. When you save your own API key, requests go straight to the provider you chose under your own terms with them.

### Billing

When an organization moves to a paid plan, Autumn runs the plans, checkout, invoices, and the billing portal, and Stripe processes the payment. We send Autumn the organization's ID and name, the email address of the admin who started checkout, its plan, and the Critiqs AI credits it used. You enter payment details on the checkout page; Critiqs never sees or stores card numbers.

### Review links

A review link shows a prototype on the website through Critiqs's review proxy, so people can comment without installing anything.

- We store the link (its key only as a hash), the prototype's address, and each viewer's short-lived access to it.
- Before a link opens, and again daily, we check its addresses (the origin and path, never the query string) with Google Web Risk.
- The proxy fetches the prototype's pages for the viewer without cookies or sign-in details, so the prototype's site sees the proxy, not the viewer. The proxy uses the viewer's IP address, in memory, to limit how many requests one viewer can make.
- We count each link's requests and bytes per day, and delete the count the day after.
- A shared build's files stay for 7 days unless the person sharing chose between 1 and 30 days, then they are deleted. Comments on it stay in the project.

### The website

critiqs.app is hosted on Vercel. Its pages load fonts from Google Fonts, so your browser asks Google's servers for them. When you sign in on the website, it keeps your sign-in in your browser's storage. The review page also remembers if you dismissed its notice about the extension.

## What the browser extension does and doesn't do

The extension:

- **Asks for no site access when you install it.** It reads a page only after you click its icon there (or press Alt+Shift+C), or on a site where you turned on **Show comments here automatically**. Chrome asks you before that setting takes effect, for that one site.
- **When you click its icon:** adds Critiqs's comment layer to the page, finds the page's project by the page's origin, and takes a screenshot of the visible tab for a new comment.
- **Keeps on your computer**, in the extension's own storage: your sign-in, the project you chose for each site, and your settings. Removing the extension deletes them.
- **Sends to Critiqs Cloud** only what this policy lists: your sign-in, the page's origin to find its project, and the comments, screenshots, page details, and page copies you create.

The extension doesn't:

- Collect your browsing history, or read pages you haven't opened Critiqs on.
- Run code from anywhere but its own package. Mockup mode shows its page copy in a frame where no script runs.
- Show ads, or sell or share your data for advertising.
- Use your data for anything but Critiqs, or to decide credit or lending.

On sites that have Critiqs built in, the extension stays out of the way and the site's own Critiqs is used.

The use of information the extension receives follows the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including its Limited Use requirements.

## Who we share data with

Other people in your projects see your display name, your comments, and their screenshots. We don't sell personal data. These services handle it for us:

| Service | What it does for Critiqs | What it receives |
| --- | --- | --- |
| Convex | Runs Critiqs Cloud's database and server code, and stores page copies, shared builds, and prepared emails | Everything in this policy that Critiqs Cloud stores (stored in the United States, AWS `us-east-1`) |
| Cloudflare R2 | Stores screenshots | Screenshots |
| Resend | Sends email | Each email's address and content, including the thread and its screenshot |
| Vercel | Hosts the critiqs.app website | Your IP address and browser details with each request |
| Google Fonts | Serves the website's fonts | Your IP address and browser details |
| Google Web Risk | Checks review links' addresses for malware, phishing, and unwanted software | The prototype's origin and path |
| Cloudflare | Runs the review proxy (when review links are enabled) | Your IP address and the pages it fetches for you |
| AI providers | Answer AI requests | What the table under [AI](#ai) lists, only when AI is used |
| Linear, GitHub, Atlassian (Jira) | Hold the tickets you create | What the section on [Trackers](#trackers) lists, only when you connect one |
| Autumn and Stripe | Run plans, checkout, and payments | What the section on [Billing](#billing) lists, only for paid plans |

We may also disclose data if required by valid legal process (such as a subpoena or court order), to prevent fraud or security harm, or as part of a merger, acquisition, or asset sale, in which case we'll notify account holders.

## How long we keep it

| Data | How long |
| --- | --- |
| Your account, organizations, and memberships | Until deleted on request. There's no way to delete an account in Critiqs yet. |
| Comments, replies, screenshots, and page details | As long as the project exists. Deleting a thread hides it from everyone, but keeps its comments and screenshot. There's no automatic deletion yet. |
| Page copies | Until the mockup is deleted, then deleted at once |
| Uploads never attached to a comment | Deleted after about an hour |
| Sign-in attempts | 30 minutes |
| Sessions | 30 days after last use, at most 90 days |
| Records of mention and reply emails | 30 days after sending. A prepared email's content is deleted once it's sent. |
| Invitations, and setup steps sent to a developer (the address and the latest email) | Kept with the organization or project |
| Credit usage sent to billing | 30 days after it's reported |
| Tracker tokens and saved AI keys | Until you disconnect or remove them |
| Addresses that reported our email as unwanted | Kept, so we don't email them again |
| Usage counts | Kept |
| Review links' daily traffic counts | Until the next day |
| Shared builds | 7 days by default (1 to 30), then their files are deleted |

Convex maintains encrypted backups for disaster recovery for up to 30 days. Deleted data rolls out of backups as they expire.

## Your choices and rights

- **See and correct.** Change your display name, and edit your comments, in Critiqs.
- **Export.** Select threads and export them as Markdown or JSON; see [Export](/docs/export).
- **Email.** Mute a project, unsubscribe from all notification emails, or change your choices in the account menu. Sign-in codes are always sent.
- **Connections.** Disconnect a tracker, remove a saved AI key, or turn off automatic comments for a site.
- **The extension.** Remove it to delete what it keeps on your computer.
- **Deletion and copies of your data.** To ask for a copy of your data, or for us to delete your account and the data tied to it, email [noahsjung@gmail.com](mailto:noahsjung@gmail.com) from your account address so we can verify who's asking. We respond within 30 days. Deleting your account removes your profile, sessions, saved keys, and tracker tokens; comments you left in other teams' projects are anonymized, or deleted on request by the project's owners. We honour access, correction, export, and deletion rights under GDPR, UK GDPR, and California's CCPA/CPRA.

## Children

Critiqs is a tool for work and isn't meant for children under 16. If we learn that someone under 16 has created an account, we'll delete the account and its data.

## Self-hosted Critiqs

Critiqs is open source. A team can run it on its own Convex deployment or inside its own server. Then comments, screenshots, page copies, emails, and AI requests go to that team's deployment and services, not to us, and that team is responsible for them.

A team-owned Convex deployment uses Critiqs Cloud's sign-in by default. Then Critiqs Cloud emails the sign-in codes and keeps each person's email address, display name, and sessions, as described above, while the team's deployment keeps everything else. A team that sets up its own sign-in sends us nothing.

The extension in the Chrome Web Store connects only to Critiqs Cloud.

## Changes

When this policy changes, we'll update this page and its effective date. Before a significant change takes effect, we'll also email account holders.

## Contact

Noah Jung, 4068 Watercourse Dr. #2407, Fort Worth, TX 76109, United States — [noahsjung@gmail.com](mailto:noahsjung@gmail.com).

This policy is governed by the laws of the State of Texas, United States. If you are in the EEA or UK, you also have the right to lodge a complaint with your local data protection supervisory authority.

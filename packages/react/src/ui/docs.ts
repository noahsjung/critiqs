/**
 * The in-app documentation: what each part of Critiqs does and how to use it,
 * as the Documentation panel shows it. Keep it in step with the interface:
 * name buttons and menu items as they read on screen.
 */
export interface DocTopic {
  id: string;
  title: string;
  /** What it is and when to use it. */
  summary: string;
  /** How to use it, one step or fact per line. */
  steps: string[];
}

export const DOCS: DocTopic[] = [
  {
    id: "start",
    title: "Getting started",
    summary: "Critiqs adds a toolbar to this prototype so reviewers can leave feedback on its elements and discuss it in threads.",
    steps: [
      "Click Sign in on the toolbar and sign in with a verified email in the window that opens. If nothing opens, allow pop-ups for this site.",
      "Everyone in the project sees your display name, never your email. Change it from your avatar menu: Change display name….",
      "Your AI…, in your avatar menu where the Critiqs backend offers it, connects your own AI; see Critiqs AI.",
      "Sign out from your avatar menu.",
    ],
  },
  {
    id: "toolbar",
    title: "Toolbar and modes",
    summary: "The toolbar at the bottom of the page switches between three modes and opens each mode's side panel.",
    steps: [
      "Browse mode (V): use the prototype normally. Its side panel shows the project.",
      "Comment mode (C): select an element to comment on it. Its side panel lists the comments.",
      "Mockup mode (M): freeze the page into a copy and ask Critiqs AI to change it. Offered only where the Critiqs backend stores mockups.",
      "The panel button opens or closes the current mode's side panel. Its badge counts unread comments.",
      "Drag a side panel's left edge to make it wider or narrower, or focus the edge and use the arrow keys. Double-click the edge to reset it. Every panel keeps the width you choose.",
      "Escape closes what is open, innermost first, ending with the side panel. It never changes the mode.",
      "Drag the grip to move the toolbar sideways, or collapse it with the arrow. It moves to the top when it would cover what you are commenting on.",
      "Ctrl or Cmd + \\ hides all of Critiqs, even while typing, and shows it again. Drafts and open windows are kept.",
    ],
  },
  {
    id: "project",
    title: "The Project panel",
    summary: "In Browse mode, the side panel shows the project: its name, its comments at a glance, who has access, and its settings.",
    steps: [
      "Comments: how many threads are open and unread. Show comments switches to Comment mode.",
      "Who has access: anyone who signs in while using this prototype can see and add comments, unless the project's owners limited it to members of its organization in Project setup. You and the people who commented most recently are listed.",
      "Your email notifications: choose which emails you get about this project.",
      "Plan usage: the project's usage against its plan, such as comments this month and Critiqs AI credits today, shown to the project's owners: its organization's admins, and the person who created it.",
      "Project ID: copy it, or open Project setup.",
    ],
  },
  {
    id: "comment",
    title: "Leaving a comment",
    summary: "Point at the exact element your feedback is about; Critiqs saves where it is, what the page showed, and a screenshot.",
    steps: [
      "Press C or click Comment mode, then click an element. The prototype doesn't react to clicks while you choose.",
      "Write in the box beside it and click Comment, or press Ctrl or Cmd + Enter.",
      "Type @ to mention someone; they get an email. Type # to add a tag.",
      "When the element shows one record among many, such as a row in a list, choose This component for that one or Matching components for every one like it. Each choice has its own help.",
      "If you leave Comment mode with text in a new comment, it is kept: press C to go back to it.",
      "A screenshot is taken automatically. If that fails, the thread offers Attach a screenshot.",
    ],
  },
  {
    id: "threads",
    title: "Pins and threads",
    summary: "Each comment starts a thread, shown by a pin beside its element.",
    steps: [
      "Click a pin to open its thread beside the element. A click in the prototype closes it.",
      "Reply in the box at the bottom, with @ mentions and # tags.",
      "Resolve a thread when it is addressed; Undo or Reopen brings it back.",
      "More actions: Copy link, Mark unread, and Delete thread….",
      "On each message: Add reaction, and Message actions to copy its link or edit your own message.",
      "Saved context shows the screenshot and details of where the comment was left. Show in prototype takes the prototype back there.",
      "When the element isn't shown as it was, Reattach… lets you select its replacement. Escape cancels.",
    ],
  },
  {
    id: "list",
    title: "The comments list",
    summary: "In Comment mode, the side panel lists the project's threads.",
    steps: [
      "Threads are grouped: In this view, Other views on this screen, and Other screens. A dot marks unread threads.",
      "Click a thread to open it beside its element.",
      "Filter shows open or resolved threads, unread only, this screen or all screens, and threads with chosen tags or tag groups. Reset clears the filters.",
      "Click a tag on a thread to show only threads with that tag.",
    ],
  },
  {
    id: "search",
    title: "Search and questions",
    summary: "The search box at the top of the comments list finds threads, and with Critiqs AI answers questions about the feedback.",
    steps: [
      "Type words or #tags to find threads. Search follows the list's status and screen filters.",
      "With AI on, ask a question in plain words. Insights answer it and cite the threads they come from; click one to open it.",
      "Without AI, search matches words and tags and is labeled Basic search.",
      "When the project needs your own AI for questions, search runs as Basic search and offers Set up your AI, which opens Your AI.",
    ],
  },
  {
    id: "tags",
    title: "Tags and tag groups",
    summary: "Tags sort feedback; groups gather related tags so everyone can filter by them.",
    steps: [
      "Type # in a comment to pick one of the project's tags or write a new one.",
      "The person who created the project manages groups: Tags and AI in the comments list's header, then Tag groups.",
      "Create group adds one. Change… renames, merges, or deletes a group; deleting keeps its tags. Groups… on a tag chooses its groups.",
      "With Critiqs AI, new tags are grouped automatically, never overriding a person's choice.",
    ],
  },
  {
    id: "export",
    title: "Exporting feedback",
    summary: "Hand a set of threads to someone else, or to a tool.",
    steps: [
      "In the comments list, click Select threads to export, then tick threads, or Select all.",
      "Click Export…, name the collection, and choose Markdown, for people, or JSON, for tools.",
      "Download or Copy it. Each thread's full discussion, links, tags, and context are included; images are not.",
    ],
  },
  {
    id: "links",
    title: "Links and notifications",
    summary: "Share a thread or a message, and choose which emails you get.",
    steps: [
      "Copy link on a thread, or Copy link to message on a message. Whoever opens it signs in and lands on that message.",
      "Email notifications…, in your avatar menu or the Project panel: emails when someone mentions you, emails about new replies in threads you're in, or mute the project.",
    ],
  },
  {
    id: "mockup",
    title: "Mockup mode",
    summary: "Show a change during a review without touching code: Critiqs AI edits a copy of the page while you talk it through.",
    steps: [
      "Press M or click Mockup mode. The page is frozen into a copy, and the panel lists mockup threads: this page's first, then other pages'. Show more loads more.",
      "Click New thread. Ask for a change to the page in the box, or select an element of the copy to ask about it. + Add existing comment, above the box, adds the project's comments for Critiqs AI to read; each shows as a chip there, with × to remove it. With comments added, you can send without typing: Critiqs AI makes the changes they ask for.",
      "Your messages and other people's sit on the right; Critiqs AI's answers sit on the left.",
      "A new thread is saved with its first message; going back before sending one saves nothing.",
      "Each Critiqs AI reply makes a version of the copy. View an earlier one, or Restore it as a new version; Back to latest returns.",
      "Hold to compare, or hold O, shows the live page instead of the copy, when the prototype shows the thread's page.",
      "For another screen width, resize the window and take a copy at that width when offered.",
      "A thread from another page asks to go there first.",
      "When your AI offers several models, the Model menu beside Send chooses which one answers. Your choice is remembered for the project.",
      "When the project needs your own AI, Critiqs AI's reply offers Set up your AI, which opens Your AI; then click Try again.",
      "Escape closes the panel and keeps the thread; V leaves Mockup mode.",
    ],
  },
  {
    id: "ai",
    title: "Critiqs AI",
    summary: "Optional AI that groups tags, answers questions about the feedback, and makes mockups.",
    steps: [
      "Critiqs AI works without setup, on your plan's credits. Your AI…, in your avatar menu, chooses its model; the menu shows what one request costs. Upgrade, beside your plan, opens Plan and billing where the deployment takes payment, or the deployment's plan page where it names one.",
      "Use your own API key sets up OpenAI, Anthropic, Google Gemini, OpenRouter, Vercel AI Gateway, or an OpenAI-compatible endpoint in three steps: the provider, the key, then the models to offer. Your own key costs no credits.",
      "Use Critiqs AI instead removes your key and goes back to Critiqs AI.",
      "The project's creator sets the project's AI in Tags and AI, under AI: AI for this project, Model, and Who pays: Project pays, personal allowed (the default: the project pays unless someone chooses their own AI), Project pays, or Each person pays (Critiqs AI on each person's plan, or their own key). Automatic grouping always uses the project's AI.",
      "Allowed models limits which Critiqs AI models requests using the project's AI may choose. The project's own model is always allowed.",
      "Changes save at once. When a request needs Your AI first, it says so and offers Set up your AI, which opens Your AI.",
      "Keys are stored encrypted and never shown again; only their last four characters are.",
      "Without AI, commenting, replies, mentions, and tags work as usual.",
    ],
  },
  {
    id: "setup",
    title: "Project setup",
    summary: "Connects this prototype to its Critiqs project, and sets where emails link to.",
    steps: [
      "Open it from the Project panel or your avatar menu: Project setup. A prototype without a project shows Set up Critiqs.",
      "To set up: sign in, name the project, then run npx critiqs init with its ID in the prototype's folder, or give the Critiqs component or tag that project ID.",
      "If you are in more than one organization, choose which one the project goes in; it starts as your own.",
      "The project ID names the project; it is not a secret.",
      "Review address: the page mention emails link to. The person who created the project can change it here.",
      "Who can review: Anyone who signs in, the default, lets anyone with the project ID read and add feedback, so share the prototype's link with clients freely. Organization members limits the project to its organization: invite reviewers to the organization, and they join when they sign in. Only the project's owners change it; everyone else sees it.",
      "Those who manage the project see its plan: Critiqs AI credits, and any other limit near full. All usage lists the rest; Plan and billing, where offered, changes the plan.",
    ],
  },
  {
    id: "organization",
    title: "Organization",
    summary: "Your organization owns its projects and their plan. Open it from your avatar menu: Organization.",
    steps: [
      "Admins manage the organization's members, its plan, and every project in it; members create projects and manage the ones they created.",
      "Admins invite people by email, as a member or an admin. The person joins when they sign in to Critiqs with that address. Invited shows invites no one has accepted yet; Withdraw cancels one.",
      "Admins open a member to change their role or remove them. An organization always keeps at least one admin.",
      "Members see who is in the organization, and can leave it.",
    ],
  },
  {
    id: "agents",
    title: "Coding agents",
    summary: "Coding agents read feedback and mockups through Critiqs's MCP tools, to fix what reviewers asked for.",
    steps: [
      "critiqs_comments and critiqs_thread read threads with their context; critiqs_screenshot returns a thread's screenshot.",
      "critiqs_reply answers in a thread as you, marked via coding agent.",
      "critiqs_mockups lists mockups, and critiqs_mockup reads one version's changes to build it in code.",
      "critiqs_sign_in signs the computer in; critiqs_doctor checks the setup.",
    ],
  },
  {
    id: "keys",
    title: "Keyboard shortcuts",
    summary: "Shortcuts work when you aren't typing in a field.",
    steps: [
      "C: Comment mode. V: Browse mode. M: Mockup mode.",
      "O, held: compare with the live page, in a Mockup thread on the page shown.",
      "Escape: close what is open, ending with the side panel.",
      "Ctrl or Cmd + Enter: send a comment, reply, or request.",
      "Ctrl or Cmd + \\: hide or show Critiqs.",
    ],
  },
];

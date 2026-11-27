// Shared hosts that hand each customer a name directly under them, as
// `vercel.app` does, but that the Public Suffix List doesn't list yet, so an
// address pattern over one (`https://*.glitch.me`) would match many unrelated
// people's sites. `isPublicSuffix` treats these as public suffixes too.
// Written by hand, not by scripts/update-public-suffixes.ts, which leaves this
// file alone and reports an entry once the list itself has it, so the entry
// can be removed here.

/** Each shared host, with where its customers' sites live. */
export const PUBLIC_SUFFIX_SUPPLEMENT: readonly { suffix: string; sites: string }[] = [
  { suffix: "glitch.me", sites: "Glitch projects, at <project>.glitch.me" },
  { suffix: "koyeb.app", sites: "Koyeb apps, at <app>-<organization>.koyeb.app" },
  { suffix: "app.github.dev", sites: "GitHub Codespaces forwarded ports, at <codespace>-<port>.app.github.dev" },
  { suffix: "loca.lt", sites: "localtunnel tunnels, at <name>.loca.lt" },
  { suffix: "lhr.life", sites: "localhost.run tunnels, at <id>.lhr.life" },
  { suffix: "serveo.net", sites: "Serveo tunnels, at <name>.serveo.net" },
  { suffix: "neocities.org", sites: "Neocities sites, at <site>.neocities.org" },
];

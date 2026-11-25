// Scripted Critiqs AI answers for the Mockup clip. Each answer finds its
// elements by their text in the page description Critiqs sends (lines such as
// `td #58 "Ops"`), the same numbers a real model would use.

interface Answer {
  reply: string;
  summary: string;
  edits: { copy: string; changes: unknown[] }[];
  remaining: boolean;
}

/** Elements of copy S1 as `{ tag, node, text }`, from its description. */
function elements(prompt: string) {
  const start = prompt.indexOf("S1:");
  const description = prompt.slice(start);
  const found: { tag: string; node: number; attrs: string; text: string }[] = [];
  for (const m of description.matchAll(/(\w+) #(\d+)([^"{\\]*)(?:\\"([^\\]*)\\")?/g)) {
    found.push({ tag: m[1]!, node: Number(m[2]), attrs: m[3] ?? "", text: m[4] ?? "" });
  }
  return found;
}

/** The request: the conversation's last message. */
function request(prompt: string) {
  return prompt.slice(-1500).toLowerCase();
}

const BAR = `<div style="margin-top:8px;height:6px;border-radius:999px;background:#2a2e36;overflow:hidden"><div style="width:70%;height:100%;border-radius:999px;background:#3d9a6c"></div></div>`;

export function answer(prompt: string): Answer {
  const asked = request(prompt);
  const els = elements(prompt);
  if (asked.includes("upgrade")) {
    const button = els.find((e) => e.tag === "button" && e.text === "Upgrade plan");
    return {
      reply: "Made Upgrade plan an outline button in the brand green, so it no longer competes with the page title.",
      summary: "Quieter Upgrade plan button",
      edits: button
        ? [{ copy: "S1", changes: [{ kind: "css", css: `[data-critiqs-node="${button.node}"] { background: transparent; color: #6fd0a0; box-shadow: inset 0 0 0 1px #3d9a6c; }` }] }]
        : [],
      remaining: false,
    };
  }
  const ops = els.filter((e) => e.tag === "td" && e.text === "Ops");
  const seats = els.find((e) => e.tag === "strong" && e.text === "14 of 20");
  return {
    reply: "Spelled out both Ops cells as Operations and added a bar under Seats showing 14 of 20 used.",
    summary: "Operations label and seat usage bar",
    edits: [{
      copy: "S1",
      changes: [
        ...ops.map((e) => ({ kind: "text", node: e.node, text: "Operations" })),
        ...(seats ? [{ kind: "insert", node: seats.node, position: "after", html: BAR }] : []),
      ],
    }],
    remaining: false,
  };
}

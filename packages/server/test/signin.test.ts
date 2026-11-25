import { expect, test } from "bun:test";
import {
  cleanCode,
  codeDigest,
  countUse,
  displayName,
  generateCode,
  MailError,
  normalizeEmail,
  preparedMessage,
  resendMailer,
  sameDigest,
  signInCodeMessage,
} from "../src/signin.ts";
import { emailImage, MentionEmail } from "../src/mention-email.ts";

test("addresses are lowercased and implausible ones refused", () => {
  expect(normalizeEmail("  Dana@Example.COM ")).toBe("dana@example.com");
  for (const bad of ["", "dana", "dana@", "@example.com", "dana@example", "a b@example.com", "<dana@example.com>", `${"x".repeat(250)}@example.com`]) {
    expect(normalizeEmail(bad)).toBeNull();
  }
});

test("display names are trimmed, single-spaced, and 1 to 60 characters without control characters", () => {
  expect(displayName("  Dana   Kim ")).toBe("Dana Kim");
  expect(displayName("   ")).toBeNull();
  expect(displayName("x".repeat(61))).toBeNull();
  expect(displayName("Dana\u0007")).toBeNull();
});

test("codes are six digits, spread across the whole range", () => {
  const codes = Array.from({ length: 2000 }, generateCode);
  expect(codes.every((code) => /^\d{6}$/.test(code))).toBe(true);
  expect(new Set(codes).size).toBeGreaterThan(1990);
  expect(codes.some((code) => code.startsWith("0"))).toBe(true);
  expect(cleanCode(" 123-456 ")).toBe("123456");
});

test("a code's digest is bound to its attempt, address, and send", async () => {
  const base = { attempt: "a1", email: "dana@example.com", generation: 1, code: "123456" };
  const digest = await codeDigest("secret", base);
  expect(digest).not.toContain("123456");
  expect(sameDigest(digest, await codeDigest("secret", base))).toBe(true);
  for (const changed of [{ attempt: "a2" }, { email: "lee@example.com" }, { generation: 2 }, { code: "123457" }]) {
    expect(sameDigest(digest, await codeDigest("secret", { ...base, ...changed }))).toBe(false);
  }
  expect(sameDigest(digest, await codeDigest("other secret", base))).toBe(false);
  expect(sameDigest("abc", "abcd")).toBe(false);
});

test("a counter allows uses up to its limit within a window, then says when to retry", () => {
  let counter = null as { count: number; expiresAt: number } | null;
  for (let i = 0; i < 3; i++) {
    const use = countUse(counter, 3, 1000, 100);
    expect(use.allowed).toBe(true);
    if (use.allowed) counter = use.next;
  }
  expect(countUse(counter, 3, 1000, 600)).toEqual({ allowed: false, retryAfterMs: 500 });
  expect(countUse(counter, 3, 1000, 1100)).toEqual({ allowed: true, next: { count: 1, expiresAt: 2100 } });
});

test("the code email names the site, and Resend receives it with the key and an idempotency key", async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const mailer = resendMailer({
    apiKey: "re_key",
    from: "Critiqs <sign-in@example.com>",
    fetch: (async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      return Response.json({ id: "1" });
    }) as unknown as typeof fetch,
  });
  const message = signInCodeMessage({ to: "dana@example.com", code: "012345", site: "https://proto.example", idempotencyKey: "k:1" });
  expect(message.subject).toBe("012345 is your Critiqs sign-in code");
  expect(message.text).toContain("https://proto.example");
  await mailer.send(message);
  const [request] = requests;
  expect(request!.url).toBe("https://api.resend.com/emails");
  expect(new Headers(request!.init.headers).get("Authorization")).toBe("Bearer re_key");
  expect(new Headers(request!.init.headers).get("Idempotency-Key")).toBe("k:1");
  expect(JSON.parse(String(request!.init.body))).toMatchObject({ from: "Critiqs <sign-in@example.com>", to: ["dana@example.com"] });

  const refusing = resendMailer({ apiKey: "re_key", from: "x@example.com", fetch: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch });
  await expect(refusing.send(message)).rejects.toBeInstanceOf(MailError);
  const offline = resendMailer({
    apiKey: "re_key",
    from: "x@example.com",
    fetch: (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch,
  });
  await expect(offline.send(message)).rejects.toBeInstanceOf(MailError);
});

test("Resend receives inline images as base64 attachments with their content ID, even large ones", async () => {
  const bodies: any[] = [];
  const mailer = resendMailer({
    apiKey: "re_key",
    from: "x@example.com",
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return Response.json({ id: "1" });
    }) as unknown as typeof fetch,
  });
  const large = new Uint8Array(3 * 1024 * 1024).map((_, i) => i % 251);
  await mailer.send({
    to: "lee@example.com",
    subject: "s",
    text: "t",
    html: `<img src="cid:critiqs-capture">`,
    idempotencyKey: "k",
    attachments: [{ filename: "capture.png", contentType: "image/png", content: large, contentId: "critiqs-capture" }],
  });
  const [attachment] = bodies[0].attachments;
  expect(attachment).toMatchObject({ filename: "capture.png", content_type: "image/png", content_id: "critiqs-capture" });
  expect(Uint8Array.from(atob(attachment.content), (char) => char.charCodeAt(0))).toEqual(large);
  // Messages without attachments send none.
  await mailer.send({ to: "lee@example.com", subject: "s", text: "t", html: "h", idempotencyKey: "k2" });
  expect(bodies[1].attachments).toBeUndefined();
});

test("a prepared email reaches Resend as the identical request whether sent prepared or as a message", async () => {
  const bodies: string[] = [];
  const mailer = resendMailer({
    apiKey: "re_key",
    from: "Critiqs <mentions@example.com>",
    fetch: (async (_url: string, init: RequestInit) => {
      bodies.push(await new Response(init.body).text());
      return Response.json({ id: "1" });
    }) as unknown as typeof fetch,
  });
  const image = new Uint8Array(3 * 1024 * 1024 + 1).map((_, i) => i % 253);
  image.set([0x89, 0x50, 0x4e, 0x47]);
  const email = new MentionEmail({
    to: "lee@example.com",
    recipientName: "Lee",
    projectName: "Pilot",
    status: "open",
    tags: ["Bug"],
    messageCount: 2,
    capture: { size: image.length, caption: "Captured." },
    mute: "https://x/mute?a=1&b=2",
    unsubscribe: "https://x/stop",
  });
  email.add([
    { messageId: "m1", authorName: "Dana \"D\" <x>", createdAt: 0, edited: false, body: "Héllo\n\"quoted\" \\ 😀 \u0001", mentions: [], mentionsYou: false, reported: false, link: null },
    { messageId: "m2", authorName: "Dana", createdAt: 1, edited: true, body: "@Lee look", mentions: [{ label: "Lee", you: true }], mentionsYou: true, reported: true, link: "https://p.example/?critiqs=t.m2" },
  ]);
  const prepared = email.finish(emailImage(image))!;
  await mailer.sendPrepared!(prepared, "k");
  await mailer.send(preparedMessage(await prepared.text(), "k"));
  expect(bodies[0]).toBe(bodies[1]!);
  const request = JSON.parse(bodies[0]!);
  expect(request.from).toBe("Critiqs <mentions@example.com>");
  expect(Uint8Array.from(atob(request.attachments[0].content), (char) => char.charCodeAt(0))).toEqual(image);
});

import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { setup } from "./harness";

export type Client = Pick<ReturnType<typeof setup>, "query">;
export async function pages<Q extends FunctionReference<"query">>(client: Client, query: Q, args: Omit<FunctionArgs<Q>, "paginationOpts">, size = 2): Promise<FunctionReturnType<Q>[]> {
  const output: FunctionReturnType<Q>[] = [];
  let cursor: string | null = null;
  while (true) {
    const run = client.query as (query: Q, args: FunctionArgs<Q>) => Promise<FunctionReturnType<Q>>;
    const result: FunctionReturnType<Q> = await run(query, { ...args, paginationOpts: { numItems: size, cursor } } as FunctionArgs<Q>);
    output.push(result);
    if (result.isDone) return output;
    if (cursor === result.continueCursor) throw new Error("Pagination did not advance");
    cursor = result.continueCursor;
  }
}
export async function thread(client: Client, args: { threadId: Id<"threads"> }) {
  const data = await pages(client, api.threads.get, args);
  const reactions = (await pages(client, api.threads.listReactions, args)).flatMap(page => page.page);
  return { ...data[0]!, messages: data.flatMap(page => page.page).map(message => {
    const summary = new Map<string, { emoji: string; count: number; mine: boolean }>();
    for (const reaction of reactions.filter(row => row.messageId === message._id)) {
      const entry = summary.get(reaction.emoji) ?? { emoji: reaction.emoji, count: 0, mine: false };
      entry.count++; entry.mine ||= reaction.mine; summary.set(reaction.emoji, entry);
    }
    return { ...message, reactions: [...summary.values()] };
  }) };
}
export async function list(client: Client, args: { projectId: Id<"projects"> }) {
  return (await pages(client, api.threads.list, args)).flatMap(page => page.page);
}
export async function mine(client: Client) {
  return (await pages(client, api.projects.listMine, {})).flatMap(page => page.page);
}
export async function exportAll(client: Client, args: { projectId: Id<"projects">; threadIds: Id<"threads">[] }) {
  let projectName = "";
  const threads = [];
  for (let threadIndex = 0; threadIndex < new Set(args.threadIds).size; threadIndex++) {
    const data = await pages(client, api.threads.exportThreads, { ...args, threadIndex });
    projectName = data[0]!.projectName;
    if (data[0]!.thread !== null) threads.push({ ...data[0]!.thread, messages: data.flatMap(page => page.page) });
  }
  return { projectName, threads };
}

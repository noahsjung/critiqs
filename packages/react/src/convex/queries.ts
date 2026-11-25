import { pageChain } from "../page-chain.ts";
import { describeError, type QueryState } from "../transport.ts";
import { useQueries } from "convex/react";
import { type FunctionArgs, type FunctionReference, type FunctionReturnType, getFunctionName } from "convex/server";

import { useEffect, useMemo, useRef, useState } from "react";

type RequestForQueries = Parameters<typeof useQueries>[0];

/**
 * Like `useQuery`, but reports Critiqs's errors (signed out, deleted thread,
 * unknown project) as values the interface can explain, instead of throwing.
 */
export function useQueryState<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
): QueryState<FunctionReturnType<Query>> {
  // `api.*` references are proxies that differ on every access, so key on the function's name.
  const name = getFunctionName(query);
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  const queries = useMemo(
    (): RequestForQueries => (args === "skip" ? {} : { result: { query, args } }),
    [name, key],
  );
  const result = useQueries(queries).result;
  if (args === "skip" || result === undefined) return { status: "loading" };
  if (result instanceof Error) return describeError(result);
  return { status: "ready", data: result };
}

/** Loads bounded live pages in order. A failed page never becomes a partial success. */
export function useAllPages<Query extends FunctionReference<"query">>(
  query: Query,
  args: Omit<FunctionArgs<Query>, "paginationOpts"> | "skip",
): QueryState<FunctionReturnType<Query>[]> {
  const name = getFunctionName(query);
  const key = args === "skip" ? "skip" : JSON.stringify(args);
  const lastComplete = useRef<{ key: string; data: FunctionReturnType<Query>[] } | null>(null);
  const [chain, setChain] = useState<{ key: string; cursors: (string | null)[] }>({ key, cursors: [null] });
  const cursors = chain.key === key ? chain.cursors : [null];
  const requests = useMemo((): RequestForQueries => args === "skip" ? {} : Object.fromEntries(
    cursors.map((cursor, i) => [String(i), { query, args: { ...args, paginationOpts: { numItems: 40, cursor } } }]),
  ), [name, key, JSON.stringify(cursors)]);
  const results = useQueries(requests);
  const { pages, next, failure, complete } = pageChain<FunctionReturnType<Query>>(cursors, results);
  const nextKey = JSON.stringify(next);
  useEffect(() => {
    if (args === "skip") {
      if (chain.key !== key) setChain({ key, cursors: [null] });
      return;
    }
    if (failure === null && (chain.key !== key || JSON.stringify(chain.cursors) !== nextKey)) {
      setChain({ key, cursors: next });
    }
  }, [key, nextKey, failure]);
  if (failure !== null) return describeError(failure);
  if (args === "skip") lastComplete.current = null;
  else if (complete) lastComplete.current = { key, data: pages };
  // Keep the current sidebar/pins and a discussion's draft mounted while a
  // live boundary update loads replacement pages. Never reuse another project.
  return args !== "skip" && lastComplete.current?.key === key
    ? { status: "ready", data: lastComplete.current.data }
    : { status: "loading" };
}

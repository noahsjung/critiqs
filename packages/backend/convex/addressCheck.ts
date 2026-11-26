"use node";

import { Resolver } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import type { AddressCheck } from "@critiqs/core";
import { checkPrototypeAddress, nodeNetwork } from "@critiqs/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import { run } from "./lib/store";

// Onboarding's check of a prototype's address, from Critiqs's servers. It
// runs in Convex's Node runtime for node:https and node:dns, which let the
// check connect only to an address it has verified is public.

const network = nodeNetwork({ http, https, Resolver });

/** What's at the address someone typed: public, sign-in, blocked, unreachable, or local. Signed-in people only, within hourly limits. */
export const check = action({
  args: { address: v.string() },
  handler: async (ctx, args): Promise<AddressCheck> =>
    run(() =>
      checkPrototypeAddress({ claim: async () => void (await ctx.runMutation(internal.onboarding.claimAddressCheck, {})), deps: network }, args),
    ),
});

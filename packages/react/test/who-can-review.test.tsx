import type { ProjectInfo } from "@critiqs/core";
import { expect, test } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { CritiqsRequestError, TransportContext } from "../src/transport.ts";
import { Setup } from "../src/ui/Setup.tsx";
import { type FakeBackend, fakeTransport } from "./fake-transport.tsx";

// Who can review: a row in project setup. The project's owners choose anyone
// who signs in or only its organization's members, and it saves at once;
// everyone else sees the choice; backends before the setting show no row.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const organization = { id: "org", name: "Acme", role: "admin" as const };
const project: ProjectInfo = { _id: "project", name: "Pilot", tags: [], createdAt: 1, reviewUrl: null, isOwner: true, organization, reviewAccess: "anyone" };

async function renderSetup(backend: Partial<FakeBackend>) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const calls: { name: string; args: unknown }[] = [];
  const toasts: string[] = [];
  const data: FakeBackend = { project, threads: [], calls, ...backend };
  const render = async () =>
    await act(async () =>
      root.render(
        <TransportContext.Provider value={fakeTransport(data)}>
          <Setup
            backLabel="Back to comments"
            reviewer={{ id: "u_dana", name: "Dana", email: "dana@example.com", pictureUrl: null }}
            signedIn
            onSignIn={() => {}}
            configuredProjectId="project"
            browserProjectId={null}
            onUseProject={() => {}}
            onDone={() => {}}
            notify={(message) => void toasts.push(message)}
          />
        </TransportContext.Provider>,
      ),
    );
  await render();
  const row = () => host.querySelector<HTMLElement>('section[aria-label="Who can review"]');
  return {
    host,
    data,
    calls,
    toasts,
    row,
    render,
    select: () => row()?.querySelector<HTMLButtonElement>(".ds-select") ?? null,
    choose: async (label: string) => {
      await act(async () => row()!.querySelector<HTMLButtonElement>(".ds-select")!.click());
      const item = [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((entry) => entry.textContent?.replace("✓", "").startsWith(label));
      await act(async () => item!.click());
    },
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

test("the project's owner sees who can review as a row, and choosing organization members saves at once", async () => {
  const setup = await renderSetup({});
  const select = setup.select()!;
  expect(setup.row()!.querySelector(".ds-row-label")!.textContent).toBe("Who can review");
  expect(select.textContent).toBe("Anyone who signs in");
  // The button is named by the row's label and its value.
  const [labelId] = select.getAttribute("aria-labelledby")!.split(" ");
  expect(setup.host.querySelector(`#${CSS.escape(labelId!)}`)!.textContent).toBe("Who can review");
  expect(setup.host.textContent).toContain("Anyone who can open the prototype and sign in sees its feedback.");

  await setup.choose("Organization members");
  expect(setup.calls).toEqual([{ name: "setReviewAccess", args: { projectId: "project", reviewAccess: "organization" } }]);
  expect(setup.toasts).toEqual(["Only organization members can review now"]);

  // The backend reports the new setting, and the page says who sees the feedback.
  setup.data.project = { ...project, reviewAccess: "organization" };
  await setup.render();
  expect(setup.select()!.textContent).toBe("Organization members");
  expect(setup.host.textContent).toContain("Only members of the project's organization see its feedback.");
  await setup.done();
});

test("the menu says what each choice means, naming the organization", async () => {
  const setup = await renderSetup({});
  await act(async () => setup.select()!.click());
  const items = [...setup.host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((item) => item.textContent);
  // The chosen option is marked.
  expect(items).toEqual(["✓Anyone who signs inAnyone with the project ID", "Organization membersAcme"]);
  await setup.done();
});

test("a refused change says why in words and leaves the setting as it was", async () => {
  const setup = await renderSetup({
    setReviewAccess: async () => {
      throw new CritiqsRequestError("forbidden", "Only the project's owners can change who can review it.");
    },
  });
  await setup.choose("Organization members");
  expect(setup.row()!.querySelector(".error")!.textContent).toBe("Only the project's owners can change who can review it.");
  expect(setup.select()!.textContent).toBe("Anyone who signs in");
  expect(setup.select()!.disabled).toBe(false);
  expect(setup.toasts).toEqual([]);
  await setup.done();
});

test("someone who doesn't manage the project sees who can review, without a control", async () => {
  const setup = await renderSetup({ project: { ...project, isOwner: false, organization: { ...organization, role: "member" }, reviewAccess: "organization" } });
  expect(setup.select()).toBeNull();
  expect(setup.row()!.querySelector(".ds-row-control")!.textContent).toBe("Organization members");
  await setup.done();
});

test("a backend from before the setting shows no row", async () => {
  const { reviewAccess: _, ...older } = project;
  const setup = await renderSetup({ project: older });
  expect(setup.row()).toBeNull();
  expect(setup.host.textContent).toContain("Anyone who can open the prototype and sign in sees its feedback.");
  await setup.done();
});

test("someone outside an organization the project is limited to is told so, not that it doesn't exist", async () => {
  const message = "This project is limited to members of its organization. Ask one of its admins to invite you.";
  const setup = await renderSetup({ projectError: { code: "forbidden", message } });
  expect(setup.host.querySelector("h3")!.textContent).toBe("No access to this project");
  expect(setup.host.textContent).toContain(message);
  expect(setup.host.textContent).not.toContain("Project not found");
  await setup.done();
});

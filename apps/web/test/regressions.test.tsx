import { expect, test } from 'bun:test';
import type { AddressCheck, OrganizationSummary, ProjectInfo } from '@critiqs/core';
import type { QueryState } from '../src/shared.ts';
import { act, StrictMode } from 'react';
import { clearFlow, clearFlowOnSignOut } from '../src/flow.ts';
import { Onboarding } from '../src/ui/Onboarding.tsx';
import { button, click, fakeAuth, fakeBackend, fakeClipboard, labelled, render, rerender, settle, text, type } from './render.tsx';

// Races and edges found in review of the three-screen onboarding, each reproduced before its fix.

const sam = fakeAuth('sam@acme.com', 'r1');
const lee = fakeAuth('lee@acme.com', 'r2');
const createChoice = /^I will/;
const developerChoice = /^My developer will/;
const callsOf = (backend: ReturnType<typeof fakeBackend>, name: string) => backend.calls.filter(call => call.name === name);
function deferred<T>() {
  let resolve!: (value: T) => void;
  const result = new Promise<T>(finish => { resolve = finish; });
  return { result, resolve };
}
async function withLink(page: Element) {
  await type(labelled(page, 'Prototype link'), 'acme.vercel.app');
  await click(button(page, 'Continue'));
}

test('does not issue a create for a previous reviewer when their address check resolves', async () => {
  sessionStorage.clear();
  const check = deferred<AddressCheck>();
  const backend = fakeBackend({ checkAddress: () => check.result });
  const page = await render(<Onboarding />, { backend, auth: sam });
  await withLink(page);
  await click(button(page, createChoice));
  expect(callsOf(backend, 'createProject')).toHaveLength(0);
  await rerender(<Onboarding />, { backend, auth: lee });
  await act(async () => check.resolve({ kind: 'public', stack: 'react' }));
  expect(page.querySelector('h1')?.textContent).toBe('What should your team review?');
  expect(callsOf(backend, 'createProject')).toEqual([]);
});

test('a create waiting on the check goes to the organization shown at the click, even if it left the list meanwhile', async () => {
  sessionStorage.clear();
  const check = deferred<AddressCheck>();
  const organizations = [
    { id: 'o1', name: 'Acme', role: 'admin' as const, plan: 'Free' as const, home: true },
    { id: 'o2', name: 'Client work', role: 'member' as const, plan: 'Plus' as const, home: false },
  ];
  const backend = fakeBackend({ organizations, checkAddress: () => check.result });
  const page = await render(<Onboarding />, { backend, auth: sam });
  await withLink(page);
  await click(button(page, createChoice));
  organizations.shift();
  await rerender(<Onboarding />, { backend, auth: sam });
  expect(text(page)).toContain('Acme is no longer one of yours');
  await act(async () => check.resolve({ kind: 'public', stack: 'react' }));
  // The server refuses an organization the person left; it never lands in another one.
  expect(callsOf(backend, 'createProject').map(call => (call.args[0] as { organizationId: string | null }).organizationId)).toEqual(['o1']);
});

test('old sends do not mark setup complete for another reviewer', async () => {
  sessionStorage.clear();
  const send = deferred<Awaited<ReturnType<ReturnType<typeof fakeBackend>['sendDeveloperSetup']>>>();
  const backend = fakeBackend({
    projectState: { status: 'ready', data: { _id: 'k57abcdefghijklmnop', name: 'My prototype', tags: [], createdAt: 0, reviewUrl: null, isOwner: true } },
    sendDeveloperSetup: () => send.result,
  });
  const page = await render(<Onboarding />, { backend, auth: sam });
  await click(button(page, "It's not online yet"));
  await click(button(page, developerChoice));
  await type(labelled(page, "Developer's email"), 'dev@acme.com');
  await click(button(page, 'Send email'));
  expect(callsOf(backend, 'sendDeveloperSetup')).toHaveLength(1);
  await rerender(<Onboarding />, { backend, auth: lee });
  await click(button(page, "It's not online yet"));
  await click(button(page, createChoice));
  expect(text(page)).not.toContain('How big is your team?');
  await act(async () => send.resolve([{ email: 'dev@acme.com', status: 'sent', sendId: 'sent', invite: 'none' }]));
  expect(text(page)).not.toContain('How big is your team?');
});

test('sign-out clears a draft written by the previous onboarding version', () => {
  sessionStorage.clear();
  sessionStorage.setItem('critiqs:onboarding:v2', JSON.stringify({ reviewer: { id: 'r1', email: 'sam@acme.com' }, step: 'address' }));
  const dispose = clearFlowOnSignOut({ subscribe: () => () => {}, getSnapshot: () => ({ reviewer: null }) }, sessionStorage);
  dispose();
  expect(sessionStorage.getItem('critiqs:onboarding:v2')).toBeNull();
});

test('focus moves to the role question when a team size button disappears', async () => {
  clearFlow(sessionStorage);
  fakeClipboard();
  const page = await render(<Onboarding />, { auth: sam });
  await click(button(page, "It's not online yet"));
  await click(button(page, createChoice));
  await click(button(page, 'Copy command'));
  const teamSize = button(page, '2–5')!;
  teamSize.focus();
  await click(teamSize);
  expect(text(page)).toContain('What do you do?');
  expect(page.querySelector('.about')?.contains(document.activeElement)).toBe(true);
});

test('invalid link puts focus on the field so the associated error is announced', async () => {
  clearFlow(sessionStorage);
  const page = await render(<Onboarding />, { auth: sam });
  const field = labelled(page, 'Prototype link')!;
  await type(field, 'my prototype');
  const continueButton = button(page, 'Continue')!;
  continueButton.focus();
  await click(continueButton);
  expect(field.getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement === field).toBe(true);
});

test('StrictMode does not double-check a submitted address', async () => {
  clearFlow(sessionStorage);
  const backend = fakeBackend();
  const page = await render(<StrictMode><Onboarding /></StrictMode>, { backend, auth: sam });
  await withLink(page);
  await settle();
  expect(callsOf(backend, 'checkAddress')).toHaveLength(1);
});

test('a new reviewer checks their own address even if they type the same link', async () => {
  clearFlow(sessionStorage);
  const backend = fakeBackend();
  const page = await render(<Onboarding />, { backend, auth: sam });
  await withLink(page);
  await click(button(page, 'Back'));
  await rerender(<Onboarding />, { backend, auth: lee });
  expect(labelled(page, 'Prototype link')?.value).toBe('');
  await withLink(page);
  expect(callsOf(backend, 'checkAddress')).toHaveLength(2);
});

test('a submit while organization is loading sends no email', async () => {
  clearFlow(sessionStorage);
  const backend = fakeBackend();
  const page = await render(<Onboarding />, { backend, auth: sam });
  await click(button(page, "It's not online yet"));
  await click(button(page, developerChoice));
  await type(labelled(page, "Developer's email"), 'dev@acme.com');
  expect(button(page, 'Send email')?.disabled).toBe(true);
  await act(async () => void (page.querySelector('form') as HTMLFormElement).requestSubmit());
  expect(callsOf(backend, 'sendDeveloperSetup')).toEqual([]);
});

test('per-recipient fallback Copy message marks setup complete', async () => {
  clearFlow(sessionStorage);
  fakeClipboard();
  const backend = fakeBackend({
    projectState: { status: 'ready', data: { _id: 'k57abcdefghijklmnop', name: 'My prototype', tags: [], createdAt: 0, reviewUrl: null, isOwner: true } },
    sendDeveloperSetup: async () => [{ email: 'dev@acme.com', status: 'suppressed' }],
  });
  const page = await render(<Onboarding />, { backend, auth: sam });
  await click(button(page, "It's not online yet"));
  await click(button(page, developerChoice));
  await type(labelled(page, "Developer's email"), 'dev@acme.com');
  await click(button(page, 'Send email'));
  expect(text(page)).not.toContain('How big is your team?');
  await click(button(page, 'Copy message for dev@acme.com'));
  expect(text(page)).toContain('How big is your team?');
});

test('when an earlier send is reported already sent, the form will not submit an empty recipient list', async () => {
  clearFlow(sessionStorage);
  const backend = fakeBackend({
    projectState: { status: 'ready', data: { _id: 'k57abcdefghijklmnop', name: 'My prototype', tags: [], createdAt: 0, reviewUrl: null, isOwner: true } },
    sendDeveloperSetup: async () => [{ email: 'dev@acme.com', status: 'already-sent', sendId: 's1' }],
  });
  const page = await render(<Onboarding />, { backend, auth: sam });
  await click(button(page, "It's not online yet"));
  await click(button(page, developerChoice));
  await type(labelled(page, "Developer's email"), 'dev@acme.com');
  await click(button(page, 'Send email'));
  expect(button(page, 'Send email')).toBeUndefined();
  await act(async () => void (page.querySelector('form') as HTMLFormElement).requestSubmit());
  expect(callsOf(backend, 'sendDeveloperSetup').map(call => call.args[1])).toEqual([['dev@acme.com']]);
});

// Round two.

const ACME = { id: 'o1', name: 'Acme', role: 'admin', plan: 'Free', home: true } satisfies OrganizationSummary;
function pendingCheck() {
  const check = deferred<AddressCheck>();
  // fakeBackend reads organizationsState on each render, so changing it here changes what the page sees.
  const overrides: { checkAddress: () => Promise<AddressCheck>; organizationsState: QueryState<OrganizationSummary[]> } = { checkAddress: () => check.result, organizationsState: { status: 'ready', data: [ACME] } };
  const backend = fakeBackend(overrides);
  return { backend, check, setOrganizations: (state: QueryState<OrganizationSummary[]>) => void (overrides.organizationsState = state) };
}
async function chooseWhileChecking(backend: ReturnType<typeof fakeBackend>) {
  sessionStorage.clear();
  const page = await render(<Onboarding />, { backend, auth: sam });
  await withLink(page);
  await click(button(page, createChoice));
  expect(callsOf(backend, 'createProject')).toEqual([]);
  return page;
}

test('organizations that fail or empty out during the check never send the create to the home organization', async () => {
  for (const state of [{ status: 'error', code: 'error', message: 'Failed' }, { status: 'ready', data: [] }] satisfies QueryState<OrganizationSummary[]>[]) {
    const { backend, check, setOrganizations } = pendingCheck();
    await chooseWhileChecking(backend);
    setOrganizations(state);
    await rerender(<Onboarding />, { backend, auth: sam });
    await act(async () => check.resolve({ kind: 'public', stack: 'react' }));
    expect(callsOf(backend, 'createProject').map(call => (call.args[0] as { organizationId: string | null }).organizationId)).toEqual(['o1']);
  }
});

test('a sign-in that is briefly not ready calls off the waiting create, and the choice is open again', async () => {
  const { backend, check } = pendingCheck();
  const page = await chooseWhileChecking(backend);
  await rerender(<Onboarding />, { backend, auth: { ...sam, ready: false } });
  expect(text(page)).toBe('Loading…');
  await act(async () => check.resolve({ kind: 'public', stack: 'react' }));
  await rerender(<Onboarding />, { backend, auth: sam });
  expect(callsOf(backend, 'createProject')).toEqual([]);
  expect(button(page, 'Back')?.disabled).toBe(false);
  expect(button(page, createChoice)?.disabled).toBe(false);
});

test('switching to the command and back while an email sends keeps its answer, invite included', async () => {
  sessionStorage.clear();
  const send = deferred<Awaited<ReturnType<ReturnType<typeof fakeBackend>['sendDeveloperSetup']>>>();
  const info: ProjectInfo = { _id: 'k57abcdefghijklmnop', name: 'My prototype', tags: [], createdAt: 0, reviewUrl: null, isOwner: true, organization: { id: 'o1', name: 'Acme', role: 'admin' } };
  const backend = fakeBackend({ organizations: [ACME], project: info, sendDeveloperSetup: () => send.result });
  const page = await render(<Onboarding />, { backend, auth: sam });
  await click(button(page, "It's not online yet"));
  await click(button(page, developerChoice));
  await type(labelled(page, "Developer's email"), 'dev@acme.com');
  await click(button(page, 'Send email'));
  await click(button(page, "I'll add it myself"));
  await act(async () => send.resolve([{ email: 'dev@acme.com', status: 'sent', sendId: 's1', invite: 'created' }]));
  await click(button(page, 'Someone else will add it'));
  expect(page.querySelector('h1')?.textContent).toBe('Email sent');
  expect(text(page)).toContain('dev@acme.com is invited to Acme.');
});

// Round three: switching to the command and back keeps the email panel as it was.

async function emailForm(backend: ReturnType<typeof fakeBackend>) {
  sessionStorage.clear();
  const page = await render(<Onboarding />, { backend, auth: sam });
  await click(button(page, "It's not online yet"));
  await click(button(page, developerChoice));
  await type(labelled(page, "Developer's email"), 'dev@acme.com');
  return page;
}
const ADMIN_PROJECT: ProjectInfo = { _id: 'k57abcdefghijklmnop', name: 'My prototype', tags: [], createdAt: 0, reviewUrl: null, isOwner: true, organization: { id: 'o1', name: 'Acme', role: 'admin' } };
const there = async (page: Element) => click(button(page, "I'll add it myself"));
const back = async (page: Element) => click(button(page, 'Someone else will add it'));

test('a send that fails while the command shows is still reported on return', async () => {
  const send = Promise.withResolvers<never>();
  const backend = fakeBackend({ organizations: [ACME], project: ADMIN_PROJECT, sendDeveloperSetup: () => send.promise });
  const page = await emailForm(backend);
  await click(button(page, 'Send email'));
  await there(page);
  await act(async () => send.reject(Object.assign(new Error('x'), { data: { code: 'unavailable', message: 'Mail service unavailable' } })));
  await settle();
  await back(page);
  expect(text(page)).toContain('Mail service unavailable');
  expect(button(page, 'Copy message instead')).toBeDefined();
});

test('a send still in flight stays in flight across a switch: no second request', async () => {
  const send = deferred<never>();
  const backend = fakeBackend({ organizations: [ACME], project: ADMIN_PROJECT, sendDeveloperSetup: () => send.result });
  const page = await emailForm(backend);
  await click(button(page, 'Send email'));
  await there(page);
  await back(page);
  expect(button(page, 'Sending…')?.disabled).toBe(true);
  await act(async () => void (page.querySelector('.panel:not([hidden]) form') as HTMLFormElement).requestSubmit());
  expect(callsOf(backend, 'sendDeveloperSetup')).toHaveLength(1);
});

test('a field being added for another developer is still there after a switch', async () => {
  const backend = fakeBackend({ organizations: [ACME], project: ADMIN_PROJECT });
  const page = await emailForm(backend);
  await click(button(page, 'Add another developer'));
  await type(labelled(page, 'Developer 2 email'), 'dev2@acme.com');
  await click(button(page, 'Send emails'));
  await settle();
  await click(button(page, 'Send to another developer'));
  await there(page);
  await back(page);
  expect(labelled(page, 'Developer 3 email')?.value).toBe('');
});

test('switching panels moves focus to the shown heading', async () => {
  const backend = fakeBackend({ organizations: [ACME], project: ADMIN_PROJECT });
  const page = await emailForm(backend);
  await there(page);
  expect(document.activeElement?.textContent).toBe('Add Critiqs to your prototype');
  await back(page);
  expect(document.activeElement?.textContent).toBe('Send the steps to your developer');
});

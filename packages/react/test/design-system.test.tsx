import { afterEach, expect, test } from "bun:test";
import { act, type ReactNode, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DialogHeader, Meter, NavRow, Select, SettingRow, Switch, usePageFocus } from "../src/ui/ds.tsx";

// The design system's shared pieces (docs/design-system.md), as people use them.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLElement | null = null;
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
});

async function render(node: ReactNode) {
  container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await act(async () => root!.render(node));
  return container;
}

async function press(target: Element, key: string) {
  await act(async () => void target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

const MODELS = [
  { value: "opus", label: "Claude Opus 5.5", detail: "5 credits" },
  { value: "haiku", label: "Claude Haiku 5.5", detail: "1 credit" },
  { value: "sol", label: "GPT-6.2 Sol", detail: "2 credits" },
];

function ModelSetting({ onChange }: { onChange: (value: string) => void }) {
  const [value, setValue] = useState("opus");
  return (
    <SettingRow label="Model">
      {(labelId) => (
        <Select
          value={value}
          options={MODELS}
          labelledBy={labelId}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
      )}
    </SettingRow>
  );
}

test("a select shows the chosen name, opens at the chosen option with each one's detail, and moves with the arrow keys", async () => {
  const changes: string[] = [];
  const host = await render(<ModelSetting onChange={(value) => changes.push(value)} />);
  const button = host.querySelector<HTMLButtonElement>(".ds-select")!;
  // Named by its setting and its value; the detail stays off the button.
  const names = button.getAttribute("aria-labelledby")!.split(" ").map((id) => host.querySelector(`[id="${id}"]`)!.textContent);
  expect(names).toEqual(["Model", "Claude Opus 5.5"]);
  expect(button.textContent).toBe("Claude Opus 5.5");
  await act(async () => button.click());
  const items = [...host.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
  expect(items.map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
    ["✓Claude Opus 5.55 credits", "true"],
    ["Claude Haiku 5.51 credit", "false"],
    ["GPT-6.2 Sol2 credits", "false"],
  ]);
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(document.activeElement).toBe(items[0]!);
  await press(items[0]!, "ArrowDown");
  expect(document.activeElement).toBe(items[1]!);
  await press(items[1]!, "ArrowUp");
  await press(items[0]!, "ArrowUp");
  expect(document.activeElement).toBe(items[2]!);
  await act(async () => items[2]!.click());
  expect(changes).toEqual(["sol"]);
  expect(button.textContent).toBe("GPT-6.2 Sol");
  expect(host.querySelector('[role="menu"]')).toBeNull();
  // Choosing the chosen option again changes nothing.
  await act(async () => button.click());
  await act(async () => host.querySelector<HTMLElement>('[role="menuitemradio"][aria-checked="true"]')!.click());
  expect(changes).toEqual(["sol"]);
});

test("a switch says whether it is on and turns at once", async () => {
  function Setting() {
    const [on, setOn] = useState(true);
    return <SettingRow label="AI for this project">{(labelId) => <Switch checked={on} onChange={setOn} labelledBy={labelId} />}</SettingRow>;
  }
  const host = await render(<Setting />);
  const toggle = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(host.querySelector(`[id="${toggle.getAttribute("aria-labelledby")}"]`)!.textContent).toBe("AI for this project");
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  await act(async () => toggle.click());
  expect(toggle.getAttribute("aria-checked")).toBe("false");
});

test("a meter reports its value and marks nearing and reaching the limit, with no bar at zero", async () => {
  const host = await render(
    <>
      <Meter value={0} max={50} label="Credits used today" />
      <Meter value={42} max={50} label="Credits used today" />
      <Meter value={60} max={50} label="Credits used today" />
    </>,
  );
  const meters = [...host.querySelectorAll('[role="meter"]')];
  expect(meters.map((meter) => [meter.className, meter.getAttribute("aria-valuenow"), meter.querySelector("span")?.getAttribute("style") ?? null])).toEqual([
    ["ds-meter", "0", null],
    ["ds-meter high", "42", "width: 84%;"],
    ["ds-meter full", "50", "width: 100%;"],
  ]);
});

test("a meter that allows extra past what is included turns red only at its ceiling, and says its amount", async () => {
  const host = await render(
    <>
      <Meter value={3_000} max={2_000} ceiling={4_000} label="Critiqs AI credits" valueText="3,000 of 2,000 · 1,000 extra" />
      <Meter value={4_000} max={2_000} ceiling={4_000} label="Critiqs AI credits" />
      <Meter value={9_000} max={2_000} ceiling={Number.POSITIVE_INFINITY} label="Critiqs AI credits" />
    </>,
  );
  const meters = [...host.querySelectorAll('[role="meter"]')];
  expect(meters.map((meter) => [meter.className, meter.getAttribute("aria-valuetext")])).toEqual([
    ["ds-meter high", "3,000 of 2,000 · 1,000 extra"],
    ["ds-meter full", null],
    ["ds-meter high", null],
  ]);
});

test("a dialog header offers Back and Close by name, with the step it is on", async () => {
  const pressed: string[] = [];
  const host = await render(<DialogHeader title="Add your key" onBack={() => pressed.push("back")} onClose={() => pressed.push("close")} step={{ current: 2, count: 3 }} />);
  expect(host.querySelector("h3")!.textContent).toBe("Add your key");
  expect(host.querySelector('[role="img"]')!.getAttribute("aria-label")).toBe("Step 2 of 3");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  expect(pressed).toEqual(["back", "close"]);
});

test("a nav row is one button showing its value", async () => {
  let opened = 0;
  const host = await render(<NavRow label="Allowed models" value="All" onClick={() => opened++} />);
  const row = host.querySelector<HTMLButtonElement>("button.ds-nav-row")!;
  expect(row.textContent).toBe("Allowed modelsAll");
  await act(async () => row.click());
  expect(opened).toBe(1);
});

test("moving to another page of a dialog moves focus to its first field or row, never on the first page", async () => {
  function Pages() {
    const [page, setPage] = useState(1);
    const ref = useRef<HTMLDivElement>(null);
    usePageFocus(ref, page);
    return (
      <div ref={ref}>
        {page === 1 ? (
          <NavRow label="Use your own API key" onClick={() => setPage(2)} />
        ) : (
          <>
            <DialogHeader title="Add your key" onBack={() => setPage(1)} />
            <input aria-label="API key" />
          </>
        )}
      </div>
    );
  }
  const host = await render(<Pages />);
  expect(document.activeElement).toBe(document.body);
  await act(async () => host.querySelector<HTMLButtonElement>(".ds-nav-row")!.click());
  expect(document.activeElement).toBe(host.querySelector('input[aria-label="API key"]'));
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
  expect(document.activeElement).toBe(host.querySelector(".ds-nav-row"));
});

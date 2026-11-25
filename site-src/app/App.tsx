import { Critiqs } from "critiqs-react";
import { useRef, useState } from "react";

// Acme is a made-up customer-accounts console: the app Critiqs is
// installed in for the landing page's clips. Only the Critiqs part is real
// product UI; everything here is sample content.

type Tab = "overview" | "team" | "billing";

const team = [
  { name: "Alex Moreno", email: "alex@harbor.example", department: "Ops", role: "Owner", seen: "Today" },
  { name: "Jordan Ellis", email: "jordan@harbor.example", department: "Finance", role: "Admin", seen: "Yesterday" },
  { name: "Sana Qureshi", email: "sana@harbor.example", department: "Field service", role: "Member", seen: "3 days ago" },
  { name: "Tomás Rivera", email: "tomas@harbor.example", department: "Ops", role: "Member", seen: "Last week" },
];

function useView() {
  const start = new URLSearchParams(location.search).get("tab");
  const [tab, setTab] = useState<Tab>(start === "overview" || start === "billing" ? start : "team");
  const latest = useRef(tab);
  latest.current = tab;
  return { tab, setTab, latest };
}

export function App() {
  const { tab, setTab, latest } = useView();
  return (
    <div className="shell">
      <aside className="nav">
        <div className="logo"><span className="mark" />Acme</div>
        <nav>
          <a>Overview</a>
          <a className="on">Customers</a>
          <a>Billing</a>
          <a>Reports</a>
          <a>Settings</a>
        </nav>
        <div className="me"><span className="av sm a4">KL</span>Kai Lindqvist</div>
      </aside>

      <main className="page" data-critiqs-record="harbor-logistics">
        <header className="top">
          <div className="crumbs">Customers <span>/</span> Harbor Logistics</div>
          <input className="search" placeholder="Search customers" readOnly />
        </header>

        <section className="title">
          <span className="av lg a3">HL</span>
          <div>
            <h1>Harbor Logistics</h1>
            <p>Customer since March 2024 · Portland, Oregon</p>
          </div>
          <button className="primary">Upgrade plan</button>
        </section>

        <section className="stats">
          <div className="stat"><span>Plan</span><strong>Growth</strong></div>
          <div className="stat" id="seats"><span>Seats</span><strong>14 of 20</strong></div>
          <div className="stat"><span>Monthly</span><strong>$1,140</strong></div>
          <div className="stat"><span>Health</span><strong className="ok">Good</strong></div>
        </section>

        <div className="tabs" role="tablist">
          {(["overview", "team", "billing"] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>
              {t[0]!.toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>

        {tab === "team" && (
          <table className="team">
            <thead>
              <tr><th>Name</th><th>Department</th><th>Role</th><th>Last seen</th></tr>
            </thead>
            <tbody>
              {team.map((p) => (
                <tr key={p.email}>
                  <td><div className="who"><span className="av sm">{p.name.split(" ").map((s) => s[0]).join("")}</span><div><b>{p.name}</b><small>{p.email}</small></div></div></td>
                  <td>{p.department}</td>
                  <td><span className="pill">{p.role}</span></td>
                  <td className="dim">{p.seen}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {tab === "overview" && (
          <div className="cards">
            <div className="card"><h3>Usage this month</h3><p className="big">82%</p><p className="dim">of included shipments</p></div>
            <div className="card"><h3>Open tickets</h3><p className="big">3</p><p className="dim">1 waiting on customer</p></div>
          </div>
        )}
        {tab === "billing" && (
          <div className="cards">
            <div className="card"><h3>Next invoice</h3><p className="big">$1,140</p><p className="dim">December 1</p></div>
            <div className="card"><h3>Payment method</h3><p className="big">Visa 4242</p><p className="dim">Expires 08/28</p></div>
          </div>
        )}
        <section className="activity">
          <h3>Recent activity</h3>
          <ul>
            <li><span className="dot" />Sana Qureshi added 2 technicians to Field service<time>2h ago</time></li>
            <li><span className="dot" />Invoice for November paid by Visa 4242<time>Yesterday</time></li>
            <li><span className="dot" />Jordan Ellis changed the billing contact<time>Nov 18</time></li>
          </ul>
        </section>
      </main>

      <Critiqs
        backend={import.meta.env.VITE_CRITIQS_BACKEND ?? "/critiqs"}
        projectId={new URLSearchParams(location.search).get("project") ?? undefined}
        version="acme-2.4.0"
        getContext={() => ({ screen: "customer", viewState: { tab: latest.current } })}
        restoreContext={({ viewState }) => {
          const t = viewState.tab;
          if (t === "overview" || t === "team" || t === "billing") setTab(t);
          return true;
        }}
      />
    </div>
  );
}

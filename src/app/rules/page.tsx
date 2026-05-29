import { db } from "@/db/client";
import { partners, partnerRules } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import Link from "next/link";

export const dynamic = "force-dynamic";

/**
 * /rules — read-only network connectivity map.
 *
 * The matrix shows, at a glance, which partner pairs can route to which.
 * Routing requires mutual allow — both (A → B) and (B → A) set to allow.
 * This page only displays state. To change a rule, click a cell — that
 * takes you to /rules/[originator]/[recipient] where the editor lives.
 */

type Rule = "allow" | "block";
type CellState = "mutual_allow" | "one_way_allow" | "blocked" | "none";

export default async function RulesPage() {
  const user = await requireUser();
  const allPartners = await db.select().from(partners).orderBy(partners.name);
  const allRules = await db.select().from(partnerRules);

  const ruleMap = new Map<string, Rule>();
  for (const r of allRules) ruleMap.set(`${r.originatorId}|${r.recipientId}`, r.rule);

  // Fleet roles see a partner-centric "who you work with" list instead of
  // the full N×N matrix. Super admins see the full matrix unchanged.
  if (user.role !== "super_admin") {
    return (
      <FleetConnectionsView
        myPartnerId={user.partnerId}
        allPartners={allPartners}
        ruleMap={ruleMap}
      />
    );
  }

  function cellState(originator: string, recipient: string): CellState {
    const a = ruleMap.get(`${originator}|${recipient}`);
    const b = ruleMap.get(`${recipient}|${originator}`);
    if (a === "allow" && b === "allow") return "mutual_allow";
    if (a === "allow" || b === "allow") return "one_way_allow";
    if (a === "block" || b === "block") return "blocked";
    return "none";
  }

  // Top-line summary numbers
  const pairs: { state: CellState }[] = [];
  for (const a of allPartners) {
    for (const b of allPartners) {
      if (a.id === b.id) continue;
      // each unordered pair only once
      if (a.id < b.id) pairs.push({ state: cellState(a.id, b.id) });
    }
  }
  const mutualCount = pairs.filter((p) => p.state === "mutual_allow").length;
  const oneWayCount = pairs.filter((p) => p.state === "one_way_allow").length;
  const blockedCount = pairs.filter((p) => p.state === "blocked").length;
  const noneCount = pairs.filter((p) => p.state === "none").length;

  return (
    <div>
      <h1>Routing connections</h1>
      <p style={{ color: "#64748b", maxWidth: 720 }}>
        Every pair of partners is one of four states. A booking only routes when both
        directions are set to allow. Click a cell to change a rule.
      </p>

      {allPartners.length < 2 ? (
        <div
          style={{
            padding: 24,
            background: "white",
            border: "1px solid #e2e8f0",
            borderRadius: 8,
            color: "#64748b",
            textAlign: "center",
          }}
        >
          You need at least two partners to set rules.{" "}
          <a href="/partners/new">Add one →</a>
        </div>
      ) : (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginTop: 16, marginBottom: 24 }}>
            <Stat label="Connected (routes)" value={mutualCount} colour="#16a34a" />
            <Stat label="One-way (does not route)" value={oneWayCount} colour="#ca8a04" />
            <Stat label="Blocked" value={blockedCount} colour="#dc2626" />
            <Stat label="No rule" value={noneCount} colour="#64748b" />
          </div>

          <div
            style={{
              overflowX: "auto",
              background: "white",
              borderRadius: 8,
              border: "1px solid #e2e8f0",
            }}
          >
            <table style={{ borderCollapse: "collapse", fontSize: 13, minWidth: "100%" }}>
              <thead>
                <tr>
                  <th style={cornerTh}>
                    <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400, lineHeight: 1.4 }}>
                      from ↓<br />to →
                    </div>
                  </th>
                  {allPartners.map((p) => (
                    <th key={p.id} style={colTh}>
                      <div>{p.name}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>{p.kind}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {allPartners.map((origin) => (
                  <tr key={origin.id}>
                    <th style={rowTh}>
                      <div>{origin.name}</div>
                      <div style={{ fontSize: 11, color: "#94a3b8", fontWeight: 400 }}>{origin.kind}</div>
                    </th>
                    {allPartners.map((recipient) => {
                      if (origin.id === recipient.id) {
                        return (
                          <td
                            key={recipient.id}
                            style={{ ...cell, background: "#f8fafc", color: "#cbd5e1", textAlign: "center" }}
                          >
                            —
                          </td>
                        );
                      }
                      const state = cellState(origin.id, recipient.id);
                      return (
                        <td key={recipient.id} style={cell}>
                          <a
                            href={`/rules/${origin.id}/${recipient.id}`}
                            style={{
                              display: "block",
                              padding: "12px 14px",
                              textDecoration: "none",
                              background: stateColour(state).bg,
                              color: stateColour(state).fg,
                              minHeight: 48,
                            }}
                          >
                            <div style={{ fontWeight: 600, fontSize: 12 }}>{stateLabel(state)}</div>
                            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                              {stateSubtitle(state, origin.name, recipient.name)}
                            </div>
                          </a>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 16, fontSize: 12, color: "#64748b" }}>
            <strong>Reading a cell:</strong> the row is the partner sending the booking; the column
            is the partner receiving it. <code>{allPartners[0]?.name ?? "Fleet A"}</code> &rarr; <code>{allPartners[1]?.name ?? "Fleet B"}</code> is the cell where the row is{" "}
            <code>{allPartners[0]?.name ?? "Fleet A"}</code> and the column is{" "}
            <code>{allPartners[1]?.name ?? "Fleet B"}</code>.
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value, colour }: { label: string; value: number; colour: string }) {
  return (
    <div
      style={{
        background: "white",
        padding: 16,
        borderRadius: 8,
        border: "1px solid #e2e8f0",
        borderLeft: `4px solid ${colour}`,
      }}
    >
      <div style={{ fontSize: 11, textTransform: "uppercase", color: "#64748b", letterSpacing: 0.5 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function stateColour(s: CellState) {
  switch (s) {
    case "mutual_allow":
      return { bg: "#dcfce7", fg: "#166534" };
    case "one_way_allow":
      return { bg: "#fef9c3", fg: "#854d0e" };
    case "blocked":
      return { bg: "#fee2e2", fg: "#991b1b" };
    case "none":
      return { bg: "white", fg: "#64748b" };
  }
}

function stateLabel(s: CellState) {
  switch (s) {
    case "mutual_allow":
      return "Connected";
    case "one_way_allow":
      return "One-way only";
    case "blocked":
      return "Blocked";
    case "none":
      return "No rule";
  }
}

function stateSubtitle(s: CellState, from: string, to: string) {
  switch (s) {
    case "mutual_allow":
      return "Routes";
    case "one_way_allow":
      return "Does not route";
    case "blocked":
      return `${to} or ${from} blocks`;
    case "none":
      return "Click to add rule";
  }
}

const cornerTh: React.CSSProperties = {
  padding: "12px",
  borderBottom: "2px solid #e2e8f0",
  borderRight: "1px solid #e2e8f0",
  background: "#f8fafc",
  width: 180,
  textAlign: "left",
};
const colTh: React.CSSProperties = {
  padding: "12px",
  borderBottom: "2px solid #e2e8f0",
  borderRight: "1px solid #e2e8f0",
  background: "#f8fafc",
  textAlign: "left",
  fontWeight: 600,
};
const rowTh: React.CSSProperties = {
  padding: "12px",
  borderBottom: "1px solid #f1f5f9",
  borderRight: "1px solid #e2e8f0",
  background: "#f8fafc",
  textAlign: "left",
  fontWeight: 600,
  minWidth: 180,
};
const cell: React.CSSProperties = {
  padding: 0,
  borderBottom: "1px solid #f1f5f9",
  borderRight: "1px solid #f1f5f9",
  minWidth: 160,
};

// ---------------------------------------------------------------------------
// Fleet-scoped view
// ---------------------------------------------------------------------------

function FleetConnectionsView({
  myPartnerId,
  allPartners,
  ruleMap,
}: {
  myPartnerId: string | null;
  allPartners: { id: string; name: string; kind: string; status: string }[];
  ruleMap: Map<string, Rule>;
}) {
  if (!myPartnerId) {
    return (
      <div className="card p-8 text-center">
        <h1 className="text-2xl font-bold tracking-tight">No fleet assigned</h1>
        <p className="text-ink-muted mt-2">
          Your account isn&apos;t associated with a partner yet. Ask a super admin
          to assign you on the <code>/users</code> page.
        </p>
      </div>
    );
  }

  const me = allPartners.find((p) => p.id === myPartnerId);
  const others = allPartners.filter((p) => p.id !== myPartnerId);

  function get(o: string, r: string) {
    return ruleMap.get(`${o}|${r}`);
  }

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <p className="text-xs uppercase tracking-[0.2em] text-ink-muted font-semibold">
          Network connections
        </p>
        <h1 className="text-3xl font-bold tracking-tight mt-1">Who you work with</h1>
        <p className="text-sm text-ink-muted mt-2 max-w-2xl">
          Pick who can send bookings to {me?.name ?? "your fleet"} and who you&apos;re willing
          to send work out to. Routing only happens when both sides agree — green means a
          booking can flow in that direction today.
        </p>
      </div>

      <div className="card">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="font-semibold">Counterparties</h2>
          <p className="text-xs text-ink-muted mt-1">
            Click any cell to change a rule. Changes are audit-logged.
          </p>
        </div>
        {others.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-ink-muted">
            No other partners on the network yet.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-ink-subtle">
              <tr>
                <th className="text-left px-5 py-3 font-semibold">Partner</th>
                <th className="text-left px-5 py-3 font-semibold">You → them</th>
                <th className="text-left px-5 py-3 font-semibold">Them → you</th>
                <th className="text-left px-5 py-3 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {others.map((other) => {
                const out = get(myPartnerId, other.id);
                const inb = get(other.id, myPartnerId);
                const mutual = out === "allow" && inb === "allow";
                return (
                  <tr key={other.id}>
                    <td className="px-5 py-3">
                      <div className="font-medium">{other.name}</div>
                      <div className="text-xs text-ink-subtle">{other.kind.replace("_", " ")}</div>
                    </td>
                    <td className="px-5 py-3">
                      <Link
                        href={`/rules/${myPartnerId}/${other.id}`}
                        className="hover:underline"
                      >
                        <RuleBadge value={out} />
                      </Link>
                    </td>
                    <td className="px-5 py-3">
                      <RuleBadge value={inb} muted />
                    </td>
                    <td className="px-5 py-3">
                      {mutual ? (
                        <span className="badge-success">routes</span>
                      ) : out === "block" || inb === "block" ? (
                        <span className="badge-danger">blocked</span>
                      ) : (
                        <span className="badge-warning">not routing</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <p className="text-xs text-ink-muted">
        The middle column shows what the other side has set — you can&apos;t change theirs. If both sides aren&apos;t allow, routing doesn&apos;t happen, even if your side is set to allow.
      </p>
    </div>
  );
}

function RuleBadge({ value, muted }: { value: Rule | undefined; muted?: boolean }) {
  if (value === "allow") return <span className={muted ? "badge-success opacity-70" : "badge-success"}>allow</span>;
  if (value === "block") return <span className={muted ? "badge-danger opacity-70" : "badge-danger"}>block</span>;
  return <span className="badge-neutral">no rule</span>;
}

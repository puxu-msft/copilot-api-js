import { NavLink } from "react-router-dom"

const ITEMS = [
  { to: "/overview", label: "Overview" },
  { to: "/requests", label: "Requests" },
  { to: "/sessions", label: "Sessions" },
  { to: "/models", label: "Models" },
  { to: "/config", label: "Config" },
] as const

export function NavRail() {
  return (
    <nav className="mono flex w-[120px] flex-col border-r border-[var(--color-border)] bg-[#15151a]">
      <div className="px-3 py-2.5 text-xs font-bold text-[var(--color-primary)]">◆ copilot-api</div>
      {ITEMS.map((it) => (
        <NavLink
          key={it.to}
          to={it.to}
          className={({ isActive }) => `px-3 py-1.5 text-[11px] ${isActive ? "bg-[#3a2f1a] text-[#f0d8a8]" : "text-[#999]"}`}
        >
          {it.label}
        </NavLink>
      ))}
    </nav>
  )
}

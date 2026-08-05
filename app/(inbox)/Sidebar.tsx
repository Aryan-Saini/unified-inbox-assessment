"use client";

import { useState } from "react";
import { SignOutButton } from "@clerk/nextjs";
import { Logo } from "../Logo";
import type { SearchRecord } from "./types";
import {
  ArchiveIcon,
  ChevronDownIcon,
  CloseIcon,
  PanelLeftIcon,
  PlusIcon,
  RerunIcon,
  SearchIcon,
  SendIcon,
  SettingsIcon,
  SignOutIcon,
  UnarchiveIcon,
} from "./icons";

function HistoryRow({
  record,
  active,
  onSelect,
  onRerun,
  onArchiveToggle,
}: {
  record: SearchRecord;
  active: boolean;
  onSelect: () => void;
  /** Runs the query again as a NEW search (`rerunOf`); selecting only reads. */
  onRerun: () => void;
  onArchiveToggle: () => void;
}) {
  return (
    <div
      className={`group relative rounded-lg transition-colors ${
        active ? "bg-white/[0.07]" : "hover:bg-white/[0.04]"
      }`}
    >
      <button
        onClick={onSelect}
        className="block w-full cursor-pointer px-2.5 py-2 text-left"
      >
        <span className="flex items-center gap-2">
          <span
            className={`min-w-0 flex-1 truncate text-[13px] ${
              active ? "text-white" : "text-neutral-300"
            }`}
          >
            {record.query}
          </span>
          {/* Time gives way to the row actions on hover. */}
          <span className="shrink-0 text-[11px] text-neutral-500 group-hover:opacity-0">
            {record.age}
          </span>
        </span>
        <span className="mt-1 flex items-center gap-2 text-[11px] text-neutral-500">
          {record.pending ? (
            <>
              <span className="h-2.5 w-2.5 animate-spin rounded-full border border-neutral-600 border-t-neutral-300" />
              <span>searching…</span>
            </>
          ) : (
            <span>{record.resultCount} results</span>
          )}
        </span>
      </button>

      <span className="absolute top-1.5 right-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <button
          onClick={onRerun}
          title="Re-run this search"
          aria-label={`Re-run search: ${record.query}`}
          className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          <RerunIcon className="h-3.5 w-3.5" />
        </button>
        <button
          onClick={onArchiveToggle}
          title={record.archived ? "Restore from archive" : "Archive search"}
          aria-label={
            record.archived
              ? `Restore search: ${record.query}`
              : `Archive search: ${record.query}`
          }
          className="rounded-md p-1.5 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
        >
          {record.archived ? (
            <UnarchiveIcon className="h-3.5 w-3.5" />
          ) : (
            <ArchiveIcon className="h-3.5 w-3.5" />
          )}
        </button>
      </span>
    </div>
  );
}

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  history,
  activeId,
  onSelect,
  onRerun,
  onNewSearch,
  onArchiveToggle,
  onOpenOutbox,
  onOpenSettings,
  sheet = false,
  onClose,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  history: SearchRecord[];
  activeId: string | null;
  onSelect: (record: SearchRecord) => void;
  onRerun: (record: SearchRecord) => void;
  onNewSearch: () => void;
  onArchiveToggle: (id: string) => void;
  onOpenOutbox: () => void;
  onOpenSettings: () => void;
  /**
   * Full-screen mobile sheet rather than the desktop rail. A phone has no room
   * for a peek of the content behind, so the sheet takes the whole viewport and
   * picking a search closes it.
   */
  sheet?: boolean;
  onClose?: () => void;
}) {
  const [archiveOpen, setArchiveOpen] = useState(false);

  // Collapsing is a desktop-rail concept; the sheet is always full width.
  const isCollapsed = collapsed && !sheet;

  const recent = history.filter((h) => !h.archived);
  const archived = history.filter((h) => h.archived);

  return (
    <aside
      className={`flex h-full flex-col bg-ink-900 ${
        sheet
          ? "w-screen"
          : `border-r border-line transition-[width] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
              isCollapsed ? "w-[64px]" : "w-[286px]"
            }`
      }`}
    >
      {/* Brand + collapse (or close, in the sheet) */}
      <div className="flex h-14 shrink-0 items-center gap-2 px-3">
        <Logo className="h-7 w-7 shrink-0 text-white" />
        <span
          className={`min-w-0 flex-1 truncate text-[13px] font-semibold tracking-tight text-white transition-opacity duration-200 ${
            isCollapsed ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
        >
          Unified Inbox
        </span>

        {sheet ? (
          <button
            onClick={onClose}
            aria-label="Close navigation"
            className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        ) : /* Collapsed, the toggle moves into the icon rail below — keeping a
              zero-opacity copy here would sit on top of the logo. */
        isCollapsed ? null : (
          <button
            onClick={onToggleCollapsed}
            aria-label="Collapse sidebar"
            title="Collapse sidebar  ⌘\"
            className="rounded-lg p-1.5 text-neutral-500 transition-colors hover:bg-white/5 hover:text-white"
          >
            <PanelLeftIcon className="h-4.5 w-4.5" />
          </button>
        )}
      </div>

      {/* Primary actions */}
      <div className="shrink-0 space-y-1 px-3 pb-3">
        {isCollapsed ? (
          <>
            <button
              onClick={onToggleCollapsed}
              aria-label="Expand sidebar"
              title="Expand sidebar  ⌘\"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-neutral-400 transition-colors hover:bg-white/5 hover:text-white"
            >
              <PanelLeftIcon className="h-4.5 w-4.5" />
            </button>
            <button
              onClick={onNewSearch}
              aria-label="New search"
              title="New search  ⌘K"
              className="flex h-9 w-9 items-center justify-center rounded-lg bg-white/[0.06] text-neutral-200 transition-colors hover:bg-white/10 hover:text-white"
            >
              <SearchIcon className="h-4.5 w-4.5" />
            </button>
          </>
        ) : (
          <button
            onClick={onNewSearch}
            className="flex w-full items-center gap-2 rounded-lg border border-line-strong bg-white/[0.03] px-2.5 py-2 text-[13px] font-medium text-neutral-200 transition-colors hover:border-neutral-600 hover:bg-white/[0.06] hover:text-white"
          >
            <PlusIcon className="h-4 w-4 shrink-0" />
            <span className="flex-1 text-left">New search</span>
            <kbd className="rounded border border-line-strong px-1.5 py-0.5 font-sans text-[10px] text-neutral-500">
              ⌘K
            </kbd>
          </button>
        )}
      </div>

      {/* History */}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3">
        {isCollapsed ? null : (
          <>
            <div className="flex items-center justify-between px-2.5 pt-1 pb-1.5">
              <span className="text-[11px] font-semibold tracking-wider text-neutral-500 uppercase">
                Searches
              </span>
            </div>

            {recent.length === 0 ? (
              <p className="px-2.5 py-3 text-[12px] leading-relaxed text-neutral-600">
                No active searches. Archived runs are still below.
              </p>
            ) : (
              <div className="space-y-0.5">
                {recent.map((record) => (
                  <HistoryRow
                    key={record.id}
                    record={record}
                    active={record.id === activeId}
                    onSelect={() => onSelect(record)}
                    onRerun={() => onRerun(record)}
                    onArchiveToggle={() => onArchiveToggle(record.id)}
                  />
                ))}
              </div>
            )}

            {archived.length > 0 ? (
              <div className="mt-4 pb-2">
                <button
                  onClick={() => setArchiveOpen((v) => !v)}
                  aria-expanded={archiveOpen}
                  className="flex w-full items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[11px] font-semibold tracking-wider text-neutral-500 uppercase transition-colors hover:text-neutral-300"
                >
                  <ChevronDownIcon
                    className={`h-3.5 w-3.5 transition-transform duration-200 ${
                      archiveOpen ? "" : "-rotate-90"
                    }`}
                  />
                  Archived
                  <span className="ml-auto font-sans text-[11px] tracking-normal normal-case">
                    {archived.length}
                  </span>
                </button>

                {/* grid-rows 1fr → 0fr animates an auto height without a fixed max. */}
                <div
                  className={`grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] ${
                    archiveOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className="space-y-0.5 pt-0.5 opacity-70">
                      {archived.map((record) => (
                        <HistoryRow
                          key={record.id}
                          record={record}
                          active={record.id === activeId}
                          onSelect={() => onSelect(record)}
                          onRerun={() => onRerun(record)}
                          onArchiveToggle={() => onArchiveToggle(record.id)}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 space-y-1 border-t border-line p-3">
        <button
          onClick={onOpenOutbox}
          title="Outbox"
          className={`flex items-center gap-2 rounded-lg text-[13px] text-neutral-400 transition-colors hover:bg-white/5 hover:text-white ${
            isCollapsed ? "h-9 w-9 justify-center" : "w-full px-2.5 py-2"
          }`}
        >
          <SendIcon className="h-4.5 w-4.5 shrink-0" />
          {isCollapsed ? null : <span className="flex-1 text-left">Outbox</span>}
        </button>
        <button
          onClick={onOpenSettings}
          title="Settings"
          className={`flex items-center gap-2 rounded-lg text-[13px] text-neutral-400 transition-colors hover:bg-white/5 hover:text-white ${
            isCollapsed ? "h-9 w-9 justify-center" : "w-full px-2.5 py-2"
          }`}
        >
          <SettingsIcon className="h-4.5 w-4.5 shrink-0" />
          {isCollapsed ? null : (
            <span className="flex-1 text-left">Settings</span>
          )}
        </button>
        {/* The only way out: `/auth` redirects a signed-in visitor straight back
            here, so signing out has to live inside the shell. */}
        <SignOutButton redirectUrl="/auth">
          <button
            title="Sign out"
            className={`flex items-center gap-2 rounded-lg text-[13px] text-neutral-400 transition-colors hover:bg-white/5 hover:text-white ${
              isCollapsed ? "h-9 w-9 justify-center" : "w-full px-2.5 py-2"
            }`}
          >
            <SignOutIcon className="h-4.5 w-4.5 shrink-0" />
            {isCollapsed ? null : (
              <span className="flex-1 text-left">Sign out</span>
            )}
          </button>
        </SignOutButton>
      </div>
    </aside>
  );
}

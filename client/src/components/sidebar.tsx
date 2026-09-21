// Left sidebar: brand mark, "New chat", and the conversation list — the
// persistent chrome around every route (new-chat empty state and individual
// conversation threads alike). Collapsible — collapsed state persists across
// reloads via localStorage. When collapsed, shrinks to a slim rail with just
// an expand button and an icon-only "new chat" shortcut.
import { useEffect, useState } from "react"
import { Link, useNavigate, useParams } from "@tanstack/react-router"
import {
  ChevronDown,
  ChevronRight,
  Folder,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Plus,
  Trash2,
  User,
  X,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { ProfileDialog } from "@/components/profile-dialog"
import { ProjectFormDialog } from "@/components/project-form-dialog"
import { ProjectMenu } from "@/components/project-menu"
import { RecordingWidget } from "@/components/recording-widget"
import { api } from "@/lib/api"
import { useConversationsContext } from "@/lib/conversations-context"
import { useLayout } from "@/lib/layout-context"
import { useProjectsContext } from "@/lib/projects-context"
import { useRecordingContext } from "@/lib/recording-context"
import type { Conversation, Project, UserProfileState } from "@/lib/api"


// Applied to every hand-rolled interactive element below instead of relying
// on the browser's default focus outline, which on some browsers/OSes
// renders as a yellow/gold ring that reads oddly against the white UI.
const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

// One row shape shared by the action items ("New chat") and the conversation
// list, so the whole sidebar reads as a single list rather than a bordered
// button sitting above a list of plain rows. The hover is kept separate
// because a conversation row that's currently active swaps it for a static
// background instead (see below).
const SIDEBAR_ROW_BASE = "flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-sm"
const SIDEBAR_ROW = `${SIDEBAR_ROW_BASE} hover:bg-[var(--sidebar-accent)]`
// A conversation filed under a project, indented under that project's row in
// the sidebar tree. Same row otherwise — pl-7 replaces the base's pl-2.5 (via
// pr-2.5 pl-7) so the delete button on the right still lines up with an
// ungrouped chat row's.
const SIDEBAR_ROW_NESTED_BASE = "flex w-full items-center gap-2 rounded-md py-1.5 pr-2.5 pl-7 text-sm"

export function Sidebar() {
  const { conversations, loading, refetch } = useConversationsContext()
  const { projects, loading: projectsLoading, refetch: refetchProjects } = useProjectsContext()
  const recording = useRecordingContext()
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  const activeId = params.conversationId
  const activeProjectId = params.projectId

  // The "+" and a row's "Edit details" share one dialog: showCreateProject
  // for the former, editingProject for the latter — only one is ever set at
  // a time. Only creation navigates once saved; an edit just refreshes.
  const [showCreateProject, setShowCreateProject] = useState(false)
  const [editingProject, setEditingProject] = useState<Project | null>(null)

  function closeProjectDialog() {
    setShowCreateProject(false)
    setEditingProject(null)
  }

  async function handleProjectSaved(project: Project) {
    const wasCreating = showCreateProject
    closeProjectDialog()
    await refetchProjects()
    if (wasCreating) {
      void navigate({ to: "/p/$projectId", params: { projectId: project.id } })
    }
  }

  // The sidebar is a drawer laid over the chat, rather than a column beside it,
  // when the window is phone-sized or the chat would otherwise get too narrow
  // (see lib/layout-math.ts). The user's collapse-to-rail choice is remembered
  // in the layout context and simply ignored while it is a drawer.
  const layout = useLayout()
  const collapsed = layout.sidebarCollapsed
  const toggleCollapsed = layout.toggleSidebarCollapsed
  const isDrawer = layout.sidebarDrawer
  const drawerOpen = isDrawer && layout.sidebarOpen
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null)
  const [pendingDeleteProject, setPendingDeleteProject] = useState<Project | null>(null)
  // Three independent levels of collapse: the whole "Chats" section, the
  // whole "Projects" section, and each project's own nested conversation
  // list. In-memory only (unlike the collapsed-rail choice, which is remembered) — this is
  // about decluttering the current session's view, not a durable preference.
  const [chatsExpanded, setChatsExpanded] = useState(true)
  const [projectsExpanded, setProjectsExpanded] = useState(true)
  const [collapsedProjectIds, setCollapsedProjectIds] = useState<Set<string>>(() => new Set())

  function toggleProjectExpanded(id: string) {
    setCollapsedProjectIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const [showProfile, setShowProfile] = useState(false)
  const [profile, setProfile] = useState<UserProfileState | null>(null)
  // Separate from `profile === null`, which can't tell "still loading" from
  // "loaded, but there's no profile yet". Without it the row renders "Set up
  // your profile" during the fetch and then swaps to the real name.
  const [profileLoading, setProfileLoading] = useState(true)

  // Loaded once for the sidebar row's label; the dialog refetches its own
  // copy when opened and hands the saved result back via onSaved.
  useEffect(() => {
    let cancelled = false
    api
      .getProfile()
      .then((p) => {
        if (!cancelled) setProfile(p)
      })
      .catch(() => {
        // Non-fatal — the row just falls back to "Set up your profile".
      })
      .finally(() => {
        if (!cancelled) setProfileLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])
  const pendingDeleteIsRecording =
    pendingDelete !== null && recording.isRecording && recording.recordingConversationId === pendingDelete.id


  function requestDelete(e: React.MouseEvent, conversation: Conversation) {
    e.preventDefault()
    e.stopPropagation()
    setPendingDelete(conversation)
  }

  async function confirmDelete() {
    if (!pendingDelete) return
    const id = pendingDelete.id
    setPendingDelete(null)
    // Deleting the conversation a recording belongs to (inline or currently
    // backgrounded behind the floating widget) would otherwise orphan it —
    // its autosaves start silently 404ing, and the widget would still point
    // at a conversation that's gone. Stop it first.
    if (recording.isRecording && recording.recordingConversationId === id) {
      recording.discardRecording()
    }
    try {
      await api.deleteConversation(id)
    } catch {
      // Already gone — discardRecording above may have just deleted it
      // itself (if it was a conversation created for that recording and
      // never sent). Either way the end state is the same.
    }
    await refetch()
    if (activeId === id) {
      void navigate({ to: "/" })
    }
  }

  async function confirmDeleteProject() {
    if (!pendingDeleteProject) return
    const id = pendingDeleteProject.id
    // Captured before the delete — once it succeeds, these conversations no
    // longer exist, and we need to know whether the route being viewed right
    // now was one of them.
    const deletedConversationIds = new Set(
      conversations.filter((c) => c.project_id === id).map((c) => c.id)
    )
    setPendingDeleteProject(null)
    try {
      await api.deleteProject(id)
    } catch {
      // Already gone — refetching below still settles the sidebar either way.
    }
    // Both lists change: the project row disappears, and its nested
    // conversation rows disappear with it (cascade-deleted server-side, not
    // orphaned) — conversations must refetch too or they'd stay stuck
    // showing under a project row that no longer exists.
    await Promise.all([refetchProjects(), refetch()])
    // Navigate away if we were looking at the project itself, OR at one of
    // the conversations just deleted with it — that route is dead now.
    if (activeProjectId === id || (activeId && deletedConversationIds.has(activeId))) {
      void navigate({ to: "/" })
    }
  }

  if (collapsed && !isDrawer) {
    return (
      <aside className="flex h-svh w-14 shrink-0 flex-col items-center gap-2 border-r border-border bg-[var(--sidebar)] py-4">
        <button
          type="button"
          onClick={toggleCollapsed}
          className={`rounded-md p-2 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
          aria-label="Expand sidebar"
          title="Expand sidebar"
        >
          <PanelLeftOpen className="size-5" />
        </button>
        <Link
          to="/"
          className={`rounded-md p-2 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
          aria-label="New chat"
          title="New chat"
        >
          <Plus className="size-5" />
        </Link>
        {/* mt-auto moves to the widget so both it and the profile stay
            pinned to the bottom, with the widget directly above. */}
        <div className="mt-auto flex flex-col items-center gap-2">
          <RecordingWidget collapsed />
          <button
            type="button"
            onClick={() => setShowProfile(true)}
            className={`rounded-md p-2 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
            aria-label="Your profile"
            title={profile?.name?.trim() || "Your profile"}
          >
            <User className="size-5" />
          </button>
        </div>
        <ProfileDialog open={showProfile} onClose={() => setShowProfile(false)} onSaved={setProfile} />
      </aside>
    )
  }

  // "Chats" is the flat, ungrouped list — a conversation filed under a
  // project is reached from that project's own page instead, the same way a
  // file inside a folder doesn't also show at the workspace root.
  const unassignedConversations = conversations.filter((c) => c.project_id === null)
  const showProjectsList = projectsLoading || projects.length > 0

  return (
    <>
      {drawerOpen ? (
        <div
          aria-hidden
          onClick={layout.closeSidebar}
          className="fixed inset-0 z-30 bg-[var(--overlay)] animate-in fade-in duration-200"
        />
      ) : null}
    <aside
      className={
        isDrawer
          ? `fixed inset-y-0 left-0 z-40 flex w-[min(20rem,85vw)] flex-col border-r border-border bg-[var(--sidebar)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
              // Shadow only while open: closed, the drawer is just off-screen and
              // its shadow would bleed onto the edge of the chat.
              drawerOpen ? "translate-x-0 shadow-xl" : "-translate-x-full"
            }`
          : "flex h-svh w-64 shrink-0 flex-col border-r border-border bg-[var(--sidebar)]"
      }
      // A closed drawer is off-screen: inert keeps keyboard focus and screen
      // readers out of it. Open, it behaves as a modal dialog.
      inert={isDrawer && !drawerOpen}
      role={drawerOpen ? "dialog" : undefined}
      aria-modal={drawerOpen || undefined}
      aria-label={isDrawer ? "Sidebar" : undefined}
      // Any link inside the drawer closes it — including "New chat" while
      // already on "/", where the route doesn't change and so wouldn't.
      onClick={
        isDrawer
          ? (e) => {
              if ((e.target as HTMLElement).closest("a")) layout.closeSidebar()
            }
          : undefined
      }
    >
      <div className="flex items-center justify-between p-4">
        <Link
          to="/"
          className={`rounded font-heading text-xl font-medium tracking-tight ${FOCUS_RING}`}
        >
          Veda
        </Link>
        <button
          type="button"
          onClick={isDrawer ? layout.closeSidebar : toggleCollapsed}
          className={`rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] ${FOCUS_RING}`}
          aria-label={isDrawer ? "Close sidebar" : "Collapse sidebar"}
          title={isDrawer ? "Close sidebar" : "Collapse sidebar"}
        >
          <PanelLeftClose className="size-5" />
        </button>
      </div>

      <div className="space-y-0.5 px-3">
        <Link to="/" className={`${SIDEBAR_ROW} ${FOCUS_RING}`}>
          <Plus className="size-4 shrink-0 text-[var(--muted)]" />
          New chat
        </Link>
      </div>

      {/* Unlike "Chats" before it (which only exists once there's something
          to list), "Projects" is always shown — it's also where a project
          gets created on a first visit, via the "+" on the right of this row
          rather than a separate standalone button above (that row used to
          live next to "New chat"; folding its action into the heading itself
          removed a whole extra row for something that isn't used often). */}
      <div className="group mt-4 flex items-center justify-between px-3">
        <h2 className="min-w-0">
          {/* Chevron sits right next to the label — not pinned to the row's
              far edge, that's where "+" lives now — and stays hidden until
              the row (the shared `group` above) is hovered or this button is
              focused, same as the +/X hover pattern elsewhere in the sidebar.
              Same px-2.5 py-1 as the "Chats" heading button below, so both
              labels sit at the same indent. */}
          <button
            type="button"
            onClick={() => setProjectsExpanded((v) => !v)}
            aria-expanded={projectsExpanded}
            className={`flex items-center gap-1 rounded px-2.5 py-1 text-sm font-normal tracking-wide text-[var(--muted)] hover:text-foreground ${FOCUS_RING}`}
          >
            Projects
            {projectsExpanded ? (
              <ChevronDown className="size-4 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            ) : (
              <ChevronRight className="size-4 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </h2>
        {/* Always visible, unlike the chevron above — this is the only way to
            create a project, so it shouldn't need a hover to discover.
            mr-2.5 pulls it in to line up with a project row's delete-X below,
            which sits inset by the row's own px-2.5 on top of this nav's px-3. */}
        <button
          type="button"
          onClick={() => setShowCreateProject(true)}
          className={`mr-2.5 shrink-0 rounded p-1 text-[var(--muted)] hover:text-foreground ${FOCUS_RING}`}
          aria-label="Create project"
          title="Create project"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {showProjectsList && projectsExpanded ? (
        <nav className="mt-1 space-y-1 px-3" aria-busy={projectsLoading} aria-label="Projects">
          {projectsLoading ? (
            <ConversationListSkeleton count={2} />
          ) : (
            projects.map((p) => {
              const projectConversations = conversations.filter((c) => c.project_id === p.id)
              const hasConversations = projectConversations.length > 0
              const projectCollapsed = collapsedProjectIds.has(p.id)
              return (
                // space-y-0.5 here (not just on the outer <nav>) is what puts
                // a gap between a project's own row and its first nested
                // chat — without it they're two bare siblings of this div
                // with nothing spacing them, so their hover backgrounds
                // touched. Same 0.5 as the gap between conversations.
                <div key={p.id} className="space-y-0.5">
                  <Link
                    to="/p/$projectId"
                    params={{ projectId: p.id }}
                    className={`group justify-between ${SIDEBAR_ROW_BASE} ${FOCUS_RING} ${
                      p.id === activeProjectId
                        ? "bg-[var(--sidebar-accent)] font-medium"
                        : "hover:bg-[var(--sidebar-accent)]"
                    }`}
                  >
                    <span className="flex min-w-0 flex-1 items-center gap-2">
                      {/* Back on the left of the name — only a project with
                          conversations gets a real toggle; an empty one has
                          nothing to hide, so a spacer keeps every name
                          starting at the same x regardless. */}
                      {hasConversations ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            toggleProjectExpanded(p.id)
                          }}
                          className={`relative inline-flex size-3.5 shrink-0 items-center justify-center rounded p-0.5 text-[var(--muted)] hover:text-foreground ${FOCUS_RING}`}
                          aria-label={
                            projectCollapsed
                              ? `Expand "${p.name || "Untitled project"}"`
                              : `Collapse "${p.name || "Untitled project"}"`
                          }
                          aria-expanded={!projectCollapsed}
                        >
                          {/* Folder by default, swapping to the expand/collapse
                              chevron on hover — stacked absolutely so the swap
                              doesn't shift the name next to it. */}
                          <Folder className="absolute size-3.5 opacity-100 group-hover:opacity-0" />
                          {projectCollapsed ? (
                            <ChevronRight className="absolute size-3.5 opacity-0 group-hover:opacity-100" />
                          ) : (
                            <ChevronDown className="absolute size-3.5 opacity-0 group-hover:opacity-100" />
                          )}
                        </button>
                      ) : (
                        <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-[var(--muted)]" aria-hidden="true">
                          <Folder className="size-3.5" />
                        </span>
                      )}
                      <span className="truncate">{p.name || "Untitled project"}</span>
                    </span>
                    {/* "..." menu, hover-only — same reveal as an ungrouped
                        chat row's delete button. A new chat inside this
                        project is created from the project page instead. */}
                    <span className="flex shrink-0 items-center">
                      <ProjectMenu
                        ariaLabel={`Actions for "${p.name || "Untitled project"}"`}
                        className={`rounded p-1.5 text-[var(--muted)] opacity-0 hover:text-foreground group-hover:opacity-100 ${FOCUS_RING}`}
                        items={[
                          { label: "Edit details", icon: Pencil, onSelect: () => setEditingProject(p) },
                          {
                            label: "Delete project",
                            icon: Trash2,
                            destructive: true,
                            onSelect: () => setPendingDeleteProject(p),
                          },
                        ]}
                      />
                    </span>
                  </Link>
                  {/* Nested under the project row it belongs to, indented —
                      a new conversation created from the project page lands
                      here, not in the flat "Chats" list below. Its own
                      space-y-1 wrapper (rather than spacing applied by the
                      outer div above) is what puts a gap between consecutive
                      nested chats — bare sibling <Link>s here would otherwise
                      have their hover backgrounds touch with no gap, same
                      issue as the project-row gap above. */}
                  {!projectCollapsed && hasConversations ? (
                    <div className="space-y-0.5">
                      {projectConversations.map((c) => (
                        <Link
                          key={c.id}
                          to="/c/$conversationId"
                          params={{ conversationId: c.id }}
                          className={`group justify-between ${SIDEBAR_ROW_NESTED_BASE} ${FOCUS_RING} ${
                            c.id === activeId
                              ? "bg-[var(--sidebar-accent)] font-medium"
                              : "hover:bg-[var(--sidebar-accent)]"
                          }`}
                        >
                          <span className="flex min-w-0 flex-1 items-center gap-2">
                            {/* A small dot, not a dash — reads as a list-item
                                bullet without competing with the indentation
                                for "this is nested" duty; the indent alone
                                said "under a project," this says "one of
                                several." */}
                            <span
                              className="size-1.5 shrink-0 rounded-full border border-[var(--muted)]"
                              aria-hidden="true"
                            />
                            <span className="truncate">{c.title}</span>
                          </span>
                          <button
                            type="button"
                            onClick={(e) => requestDelete(e, c)}
                            className={`shrink-0 rounded p-1 text-[var(--muted)] opacity-0 hover:text-[var(--error)] group-hover:opacity-100 ${FOCUS_RING}`}
                            aria-label={`Delete "${c.title}"`}
                          >
                            <X className="size-4" />
                          </button>
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              )
            })
          )}
        </nav>
      ) : null}

      {/* Also always shown now, same reasoning as "Projects" above — a
          section label that's part of the sidebar's fixed structure, not a
          conditional list caption. No "+" here: "New chat" already has its
          own permanent row above, unlike "Create project" which just moved
          into its heading. */}
      <div className="group mt-4 px-3">
        <h2>
          {/* Chevron next to the label, hover/focus-only — same as the
              "Projects" heading, see its comment for the reasoning. */}
          <button
            type="button"
            onClick={() => setChatsExpanded((v) => !v)}
            aria-expanded={chatsExpanded}
            className={`flex items-center gap-1 rounded px-2.5 py-1 text-sm font-normal tracking-wide text-[var(--muted)] hover:text-foreground ${FOCUS_RING}`}
          >
            Chats
            {chatsExpanded ? (
              <ChevronDown className="size-4 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            ) : (
              <ChevronRight className="size-4 shrink-0 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" />
            )}
          </button>
        </h2>
      </div>

      {/* The <nav> itself stays mounted even when collapsed — it carries
          flex-1, which is what pins the recording widget and profile row to
          the bottom of the sidebar. Hiding the element entirely would collapse
          that spacer and pull them back up under the heading. Only the list
          inside is conditional. */}
      <nav
        className="thin-scrollbar flex-1 space-y-0.5 overflow-y-auto px-3"
        aria-busy={loading}
        aria-label="Conversations"
      >
        {!chatsExpanded ? null : loading ? (
          <ConversationListSkeleton />
        ) : (
          unassignedConversations.map((c) => (
            <Link
              key={c.id}
              to="/c/$conversationId"
              params={{ conversationId: c.id }}
              // Own token (--sidebar-accent), deliberately separate from the
              // generic --hover used elsewhere (e.g. the mic/computer-audio
              // menu) — computed manually rather than via activeProps layered
              // on a separate static hover class, since those would point at
              // two different colors and race in the compiled CSS for whichever
              // wins on :hover while a row is active.
              className={`group justify-between ${SIDEBAR_ROW_BASE} ${FOCUS_RING} ${
                c.id === activeId ? "bg-[var(--sidebar-accent)] font-medium" : "hover:bg-[var(--sidebar-accent)]"
              }`}
            >
              <span className="flex min-w-0 flex-1 items-center gap-2 pl-1">
                <span className="size-1.5 shrink-0 rounded-full border border-[var(--muted)]" aria-hidden="true" />
                <span className="truncate">{c.title}</span>
              </span>
              <button
                type="button"
                onClick={(e) => requestDelete(e, c)}
                className={`shrink-0 rounded p-1 text-[var(--muted)] opacity-0 hover:text-[var(--error)] group-hover:opacity-100 ${FOCUS_RING}`}
                aria-label={`Delete "${c.title}"`}
              >
                <X className="size-4" />
              </button>
            </Link>
          ))
        )}
      </nav>

      {/* Above the profile row and inside the sidebar's normal flow, so it
          pushes the profile down instead of covering it. Renders nothing
          unless a recording is running somewhere else. */}
      {/* p-2 — the same padding as the profile block below, so the two rows
          sit identically inside their containers and their hover rectangles
          are the same distance from the divider between them. */}
      <div className="p-2">
        <RecordingWidget />
      </div>

      <div className="border-t border-border p-2" aria-busy={profileLoading}>
        {profileLoading ? (
          <ProfileRowSkeleton />
        ) : (
          <button
            type="button"
            onClick={() => setShowProfile(true)}
            className={`${SIDEBAR_ROW} ${FOCUS_RING}`}
            title="Tell the AI who it's writing for"
          >
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-[var(--sidebar-accent)] text-[var(--muted)]">
              <User className="size-4" />
            </span>
            <span className="min-w-0 flex-1 text-left">
              <span className="block truncate text-sm">
                {profile?.name?.trim() || (profile?.has_profile ? "Your profile" : "Set up your profile")}
              </span>
              {profile?.fields?.occupation?.trim() ? (
                <span className="block truncate text-xs text-[var(--muted)]">
                  {profile.fields.occupation}
                </span>
              ) : null}
            </span>
          </button>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete conversation?"
        description={
          pendingDelete
            ? `"${pendingDelete.title}" and its notes will be permanently deleted. This can't be undone.${
                pendingDeleteIsRecording ? " It also has a recording in progress — that will be stopped too." : ""
              }`
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={pendingDeleteProject !== null}
        title="Delete this project?"
        description={
          pendingDeleteProject
            ? (() => {
                const count = conversations.filter((c) => c.project_id === pendingDeleteProject.id).length
                const conversationPhrase =
                  count === 0
                    ? "It has no conversations in it."
                    : `This also permanently deletes ${count} conversation${count === 1 ? "" : "s"} and ${
                        count === 1 ? "its" : "their"
                      } notes.`
                return `"${pendingDeleteProject.name || "Untitled project"}" will be deleted. ${conversationPhrase} This can't be undone.`
              })()
            : ""
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void confirmDeleteProject()}
        onCancel={() => setPendingDeleteProject(null)}
      />

      <ProjectFormDialog
        open={showCreateProject || editingProject !== null}
        project={editingProject}
        onSaved={(project) => void handleProjectSaved(project)}
        onCancel={closeProjectDialog}
      />

      <ProfileDialog open={showProfile} onClose={() => setShowProfile(false)} onSaved={setProfile} />
    </aside>
    </>
  )
}

/** Placeholder rows matching conversation link height while the list loads. */
function ConversationListSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="space-y-1" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        // Same row chrome + delete-button footprint as a real chat link so
        // the bars line up with where truncated titles sit.
        <div key={i} className={`${SIDEBAR_ROW_BASE} pointer-events-none justify-between`}>
          <div
            className="h-5 min-w-0 flex-1 animate-pulse rounded bg-[var(--sidebar-accent)]"
            style={{ animationDelay: `${i * 90}ms` }}
          />
          <div className="size-6 shrink-0" />
        </div>
      ))}
    </div>
  )
}

/** Placeholder matching the profile row while the profile loads. */
function ProfileRowSkeleton() {
  return (
    // Same row chrome and the same size-7 avatar circle as the real button,
    // so the label lands exactly where the bar was. Two bars because the
    // filled-in profile — name over occupation — is the steady state; a
    // profile with no occupation renders one line and settles 8px shorter.
    <div className={`${SIDEBAR_ROW_BASE} pointer-events-none`} aria-hidden>
      <span className="size-7 shrink-0 animate-pulse rounded-full bg-[var(--sidebar-accent)]" />
      <span className="min-w-0 flex-1 space-y-1">
        {/* h-4/h-3 rather than the text's own line-height: bars sized to the
            glyphs read as text, where full-line-height bars read as blocks. */}
        <span
          className="block h-4 w-24 animate-pulse rounded bg-[var(--sidebar-accent)]"
          // Offset like the conversation rows above, so the sidebar pulses as
          // one thing rather than several independent loaders.
          style={{ animationDelay: "180ms" }}
        />
        <span
          className="block h-3 w-16 animate-pulse rounded bg-[var(--sidebar-accent)]"
          style={{ animationDelay: "270ms" }}
        />
      </span>
    </div>
  )
}

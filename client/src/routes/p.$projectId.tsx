// A single project — its name/description and the conversations filed under
// it. Editing (name/type/description/instructions) and deleting both live
// behind the "..." menu next to the title now, not as an inline form here —
// the same menu a project's sidebar row has. "New chat" here creates eagerly
// (unlike the global "New chat", which creates lazily on first send) so the
// conversation is filed in this project from the moment it exists, rather
// than needing a second step to assign it afterward — there is no
// move-between-projects UI.
import { useEffect, useState } from "react"
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { AlertCircle, Loader2, Pencil, Plus, Trash2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { ProjectFormDialog } from "@/components/project-form-dialog"
import { ProjectMenu } from "@/components/project-menu"
import { api, GENERIC_ERROR } from "@/lib/api"
import { SidebarToggle } from "@/components/sidebar-toggle"
import { useConversationsContext } from "@/lib/conversations-context"
import { useProjectsContext } from "@/lib/projects-context"

export const Route = createFileRoute("/p/$projectId")({
  // Always refetch on revisit, same reasoning as /c/$conversationId: cached
  // loader data can go stale (a conversation added since, a rename elsewhere).
  loader: ({ params }) => api.getProject(params.projectId),
  staleTime: 0,
  gcTime: 0,
  component: ProjectPage,
})

const FOCUS_RING = "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function ProjectPage() {
  const loaderProject = Route.useLoaderData()
  const { projectId } = Route.useParams()
  const navigate = useNavigate()
  const conversationsCtx = useConversationsContext()
  const projectsCtx = useProjectsContext()

  // A local, editable copy of the loaded project — updated in place when the
  // "Edit details" dialog saves, so the header reflects it without a
  // round-trip through the route loader.
  const [project, setProject] = useState(loaderProject)
  const [conversations, setConversations] = useState(loaderProject.conversations)
  const [creatingChat, setCreatingChat] = useState(false)
  const [showEditProject, setShowEditProject] = useState(false)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The loader only re-runs on navigation, not on every render — resync
  // local state when the route actually loads a (possibly different) project.
  useEffect(() => {
    setProject(loaderProject)
    setConversations(loaderProject.conversations)
  }, [loaderProject])

  async function handleNewChat() {
    setCreatingChat(true)
    setError(null)
    try {
      const conversation = await api.createConversation(projectId)
      await conversationsCtx.refetch()
      void navigate({ to: "/c/$conversationId", params: { conversationId: conversation.id } })
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
      setCreatingChat(false)
    }
  }

  async function handleDeleteProject() {
    setConfirmingDelete(false)
    try {
      await api.deleteProject(projectId)
    } catch (err) {
      setError(err instanceof Error ? err.message : GENERIC_ERROR)
      return
    }
    await Promise.all([projectsCtx.refetch(), conversationsCtx.refetch()])
    void navigate({ to: "/" })
  }

  return (
    <div className="thin-scrollbar h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-8">
        <SidebarToggle className="-ml-1.5 mb-3" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="truncate font-heading text-[26px] font-medium tracking-tight">
              {project.name || "Untitled project"}
            </h1>
            {project.description ? (
              <p className="mt-1.5 text-base text-[var(--muted)]">{project.description}</p>
            ) : null}
          </div>
          <ProjectMenu
            ariaLabel={`Actions for "${project.name || "Untitled project"}"`}
            className={`shrink-0 rounded p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-foreground ${FOCUS_RING}`}
            items={[
              { label: "Edit details", icon: Pencil, onSelect: () => setShowEditProject(true) },
              {
                label: "Delete project",
                icon: Trash2,
                destructive: true,
                onSelect: () => setConfirmingDelete(true),
              },
            ]}
          />
        </div>

        {error ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2.5 rounded-xl border border-[var(--error)]/25 bg-[var(--error-bg)] px-3.5 py-2.5 text-[var(--error)]"
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <p className="min-w-0 flex-1 text-base leading-snug break-words">{error}</p>
          </div>
        ) : null}

        {/* Same conversations the sidebar nests under this project, shown
            here too so the project page itself is a browsable list. */}
        <div className="mt-8 mb-2 flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium tracking-wide text-[var(--muted)] uppercase">Chats</h2>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void handleNewChat()}
            disabled={creatingChat}
            className="h-7 gap-1.5 px-2.5 text-sm"
          >
            {creatingChat ? <Loader2 className="size-3.5 animate-spin" /> : <Plus className="size-3.5" />}
            New chat
          </Button>
        </div>

        {conversations.length > 0 ? (
          <div className="mt-3 flex flex-col">
            {conversations.map((c) => (
              <Link
                key={c.id}
                to="/c/$conversationId"
                params={{ conversationId: c.id }}
                className="flex items-center justify-between gap-4 rounded-lg px-3 py-4 text-sm hover:bg-[var(--hover)]"
              >
                <span className="truncate font-medium">{c.title}</span>
                <span className="shrink-0 text-xs text-[var(--muted)]">{formatDate(c.updated_at)}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="mt-3 py-4 text-base text-[var(--muted)]">No conversations yet.</p>
        )}
      </div>

      <ProjectFormDialog
        open={showEditProject}
        project={project}
        onSaved={(saved) => {
          setProject((prev) => ({ ...prev, ...saved }))
          setShowEditProject(false)
          void projectsCtx.refetch()
        }}
        onCancel={() => setShowEditProject(false)}
      />

      <ConfirmDialog
        open={confirmingDelete}
        title="Delete this project?"
        description={
          conversations.length === 0
            ? `"${project.name || "Untitled project"}" will be deleted. It has no conversations in it. This can't be undone.`
            : `"${project.name || "Untitled project"}" will be deleted. This also permanently deletes ${
                conversations.length
              } conversation${conversations.length === 1 ? "" : "s"} and ${
                conversations.length === 1 ? "its" : "their"
              } notes. This can't be undone.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => void handleDeleteProject()}
        onCancel={() => setConfirmingDelete(false)}
      />
    </div>
  )
}

// The shared shell every route renders inside — TanStack Router requires one
// root route as the top of the route tree. Layout is now sidebar + content
// (chat-app shape) instead of a top navbar, since the app is a conversation
// UI rather than a marketing site. ConversationsProvider wraps everything so
// the sidebar's conversation list can be refetched from any route (e.g.
// after sending a message) without prop-drilling. <Outlet /> renders the
// matched page (index.tsx = new-chat state, c.$conversationId.tsx = a
// thread).
import { createRootRoute, Outlet } from "@tanstack/react-router"

import { Sidebar } from "@/components/sidebar"
import { ConversationsProvider } from "@/lib/conversations-context"
import { ProjectsProvider } from "@/lib/projects-context"
import { RecordingProvider } from "@/lib/recording-context"

export const Route = createRootRoute({
  component: () => (
    <ConversationsProvider>
      <ProjectsProvider>
        {/* RecordingProvider lives here, above <Outlet />, specifically so a
            recording survives navigating between routes — it used to live
            inside ChatComposer, which meant switching conversations mid-
            recording tore the whole session down. */}
        <RecordingProvider>
          <div className="flex h-svh bg-background text-foreground">
            <Sidebar />
            <div className="flex-1 overflow-hidden">
              <Outlet />
            </div>
          </div>
        </RecordingProvider>
      </ProjectsProvider>
    </ConversationsProvider>
  ),
})

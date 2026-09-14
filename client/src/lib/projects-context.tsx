// Shares the sidebar's project list + a refetch() trigger across the app,
// so creating/renaming/deleting a project from its own page can make the
// sidebar re-fetch without prop-drilling. Same pattern as
// conversations-context.tsx.
import { createContext, useContext } from "react"

import { useProjects } from "@/lib/use-projects"
import type { Project } from "@/lib/api"

type ProjectsContextValue = {
  projects: Project[]
  loading: boolean
  refetch: () => Promise<void>
}

const ProjectsContext = createContext<ProjectsContextValue | null>(null)

export function ProjectsProvider({ children }: { children: React.ReactNode }) {
  const value = useProjects()
  return <ProjectsContext value={value}>{children}</ProjectsContext>
}

export function useProjectsContext() {
  const ctx = useContext(ProjectsContext)
  if (!ctx) {
    throw new Error("useProjectsContext must be used within ProjectsProvider")
  }
  return ctx
}

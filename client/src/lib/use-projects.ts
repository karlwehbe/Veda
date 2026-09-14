// Sidebar's project list — same shape as use-conversations.ts: fetched
// independently of route navigation, with a refetch() callers trigger after
// creating/renaming/deleting so the list stays in sync.
import { useCallback, useEffect, useState } from "react"

import { api, type Project } from "@/lib/api"

export function useProjects() {
  const [projects, setProjects] = useState<Project[]>([])
  // True only until the first list fetch settles — later refetches keep the
  // existing rows visible instead of flashing skeletons.
  const [loading, setLoading] = useState(true)

  const refetch = useCallback(async () => {
    try {
      setProjects(await api.listProjects())
    } catch {
      // Sidebar just stays empty/stale — not worth surfacing an error for.
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refetch()
  }, [refetch])

  return { projects, loading, refetch }
}

import {
  //
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import type { ConfigYaml } from "@/types/status"

import { api } from "@/lib/api"

export function useConfigYaml() {
  const queryClient = useQueryClient()
  const query = useQuery({ queryKey: ["config-yaml"], queryFn: () => api.get<ConfigYaml>("/api/config/yaml") })
  const save = useMutation({
    mutationFn: (cfg: ConfigYaml) => api.put<ConfigYaml>("/api/config/yaml", cfg),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["config-yaml"] }),
  })
  return { query, save }
}

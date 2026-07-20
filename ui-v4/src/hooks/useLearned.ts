import {
  //
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query"

import type {
  //
  LearnedSnapshot,
  NegotiationCategory,
} from "@/types"

import { api } from "@/lib/api"

export interface EntryRef {
  category: NegotiationCategory
  key: string
  value: string
}

export function useLearned() {
  const qc = useQueryClient()
  const query = useQuery({ queryKey: ["learned"], queryFn: () => api.get<LearnedSnapshot>("/api/negotiation") })
  const invalidate = () => qc.invalidateQueries({ queryKey: ["learned"] })

  const renew = useMutation({ mutationFn: (r: EntryRef) => api.post("/api/negotiation/renew", r), onSuccess: invalidate })
  const expire = useMutation({ mutationFn: (r: EntryRef) => api.post("/api/negotiation/expire", r), onSuccess: invalidate })
  const setPin = useMutation({
    mutationFn: (r: EntryRef & { pinned: boolean }) => api.post("/api/negotiation/pin", r),
    onSuccess: invalidate,
  })
  const remove = useMutation({ mutationFn: (r: EntryRef) => api.post("/api/negotiation/entry/delete", r), onSuccess: invalidate })

  return { query, renew, expire, setPin, remove }
}

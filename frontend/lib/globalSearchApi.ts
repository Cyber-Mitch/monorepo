import { searchProperties } from "@/lib/propertiesApi"
import { apiGet, withQuery } from "@/lib/apiClient"

export interface SearchResult {
  id: string
  type: "property" | "deal" | "document" | "transaction"
  title: string
  subtitle: string
  href: string
}

export interface GroupedResults {
  label: string
  results: SearchResult[]
}

async function searchPropertiesApi(query: string): Promise<SearchResult[]> {
  try {
    const res = await searchProperties({ query, pageSize: 5 })
    return (res.data ?? []).map((p) => ({
      id: p.listingId,
      type: "property" as const,
      title: p.address,
      subtitle: [p.city, p.area, `${p.bedrooms} bed, ${p.bathrooms} bath`]
        .filter(Boolean)
        .join(" - "),
      href: `/properties/${p.listingId}`,
    }))
  } catch {
    return []
  }
}

async function searchDealsApi(query: string): Promise<SearchResult[]> {
  try {
    const path = withQuery("/api/deals/search", {
      q: query,
      pageSize: 5,
    })
    const res = await apiGet<{
      data?: Array<{ id: string; title: string; status: string }>
    }>(path)
    return (res.data ?? []).map((d) => ({
      id: d.id,
      type: "deal" as const,
      title: d.title,
      subtitle: d.status,
      href: `/deals/${d.id}`,
    }))
  } catch {
    return []
  }
}

async function searchTransactionsApi(query: string): Promise<SearchResult[]> {
  try {
    const path = withQuery("/api/transactions/search", {
      q: query,
      pageSize: 5,
    })
    const res = await apiGet<{
      data?: Array<{ id: string; description: string; amount: string }>
    }>(path)
    return (res.data ?? []).map((t) => ({
      id: t.id,
      type: "transaction" as const,
      title: t.description ?? "Transaction",
      subtitle: t.amount ?? "",
      href: `/transactions/${t.id}`,
    }))
  } catch {
    return []
  }
}

export async function globalSearch(
  query: string,
  isAuthenticated: boolean,
): Promise<GroupedResults[]> {
  if (!query.trim()) return []

  const groups: GroupedResults[] = []

  const properties = await searchPropertiesApi(query)
  if (properties.length > 0) {
    groups.push({ label: "Properties", results: properties })
  }

  if (isAuthenticated) {
    const [deals, transactions] = await Promise.all([
      searchDealsApi(query),
      searchTransactionsApi(query),
    ])

    if (deals.length > 0) groups.push({ label: "Deals", results: deals })
    if (transactions.length > 0) groups.push({ label: "Transactions", results: transactions })
  }

  return groups
}

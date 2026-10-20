'use client'

import { useCurrency } from '@/contexts/CurrencyContext'
import type { DisplayCurrency } from '@/lib/currency'

export function CurrencyToggle() {
  const { displayCurrency, isHydrated, setDisplayCurrency } = useCurrency()

  const options: DisplayCurrency[] = ['NGN', 'USDC']

  return (
    <div
      className="inline-flex items-center rounded-md border-2 border-foreground overflow-hidden text-xs font-mono font-bold"
      role="group"
      aria-label="Display currency"
    >
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => setDisplayCurrency(opt)}
          disabled={!isHydrated}
          className={`px-2.5 py-1 transition-colors disabled:cursor-not-allowed ${
            isHydrated && displayCurrency === opt
              ? 'bg-primary text-foreground'
              : 'bg-background text-foreground hover:bg-muted'
          }`}
          aria-pressed={isHydrated && displayCurrency === opt}
        >
          {opt}
        </button>
      ))}
    </div>
  )
}
